# Gemeinsame Nutzung von CPU, RAM, GPU/VRAM und SSD für lokale Modelle

Stichtag: 2026-09-11
Ergänzung zu `tauri-und-lokale-llm-optimierung.md`.

Hostbezug: die Angaben rechnen mit dem im Preflight-Report vom 2026-09-05 belegten Testhost – Intel i9-10900K (10 Kerne / 20 Threads), 34.223.976.448 Bytes RAM, NVIDIA RTX 3090 mit 24.576 MiB VRAM, Treiber 560.94, festes Speichermedium mit 769 GB frei.

---

## 1. Die entscheidende Einschränkung: Ressourcen addieren sich nicht

Die Token-Generierung (Decode) ist **bandbreitenlimitiert**, nicht rechenlimitiert. Für jedes einzelne Token wird jedes aktive Gewicht genau einmal aus dem Speicher gelesen. Die Zeit pro Token ist deshalb die **Summe** über alle beteiligten Speicherebenen, nicht das Maximum:

```
t_token ≈ Σ (Bytes auf Tier_i / Bandbreite Tier_i)
```

Der langsamste beteiligte Tier dominiert sofort. „Alles zusammen nutzen" macht das System deshalb nicht schneller, sondern gibt **Kapazität gegen Geschwindigkeit**.

### Bandbreiten auf deinem Host

| Ebene | Bandbreite (Größenordnung) | relativ zu VRAM |
| --- | --- | --- |
| RTX 3090 GDDR6X | ~936 GB/s | 1× |
| DDR4 Dual-Channel | ~40–50 GB/s | ~20× langsamer |
| PCIe 3.0 ×16 (Comet Lake hat kein PCIe 4.0) | ~13 GB/s effektiv | ~70× langsamer |
| NVMe Gen3 | ~3,5 GB/s | ~270× langsamer |

### Was das für dein aktuelles Modell bedeutet

OrcaRouter Qwen3.8-27B Q4_K_M = 17,77 GB Datei, ~16,5 GiB Gewichte, **dicht** – also ist bei jedem Token das gesamte Modell aktiv.

| Verteilung | Rechnung | theoretisch | Realität ≈ 55 % davon |
| --- | --- | --- | --- |
| 100 % VRAM | 16,5/936 = 18 ms | ~56 tok/s | ~30 tok/s (deckt sich mit deinen 27,8–31,4) |
| 90 % GPU / 10 % RAM | 16 ms + 37 ms = 53 ms | ~19 tok/s | ~10 tok/s |
| 75 % / 25 % | 13 ms + 92 ms = 105 ms | ~9,5 tok/s | ~5 tok/s |
| 50 % / 50 % | 9 ms + 183 ms = 192 ms | ~5 tok/s | ~3 tok/s |

**Bereits 10 % Auslagerung halbiert die Geschwindigkeit.** Das ist die bekannte Offload-Klippe.

Für die SSD gilt dieselbe Rechnung: 16,5 GB / 3,5 GB/s ≈ **4,7 Sekunden pro Token**. Eine SSD ist als Gewichtespeicher für aktive Inferenz grundsätzlich unbrauchbar, unabhängig von der Implementierung.

### CPU-Rechenleistung addiert sich ebenfalls nicht

llama.cpp rechnet Layer **sequenziell**. Während die GPU Layer 5 rechnet, hat die CPU nichts zu tun und umgekehrt. Es gibt keine gleichzeitige Nutzung beider Recheneinheiten für denselben Token. Echte Überlappung existiert nur beim Prefill mit großen Batches (siehe 2.4) und bei paralleler Batchverarbeitung mehrerer Requests.

**Merksatz:** VRAM und RAM addieren sich für *Kapazität*. CPU und GPU addieren sich *nicht* für Decode-Geschwindigkeit. SSD addiert sich für gar nichts, was pro Token gelesen wird.

---

## 2. Wo mehrstufige Nutzung tatsächlich funktioniert

### 2.1 Mixture-of-Experts – die einzige Architektur, bei der das Konzept aufgeht

Bei MoE-Modellen ist pro Token nur ein Bruchteil der Parameter aktiv (z. B. 35 Mrd. gesamt, ~3 Mrd. aktiv). Damit ändert sich die Rechnung grundlegend: die langsame RAM-Ebene wird pro Token nur für wenige Experten gelesen.

Die bewährte Aufteilung:

| Komponente | Ziel | Begründung |
| --- | --- | --- |
| Attention | GPU | bei jedem Token aktiv |
| dichte FFN | GPU | bei jedem Token aktiv |
| Shared Experts | GPU | bei jedem Token aktiv |
| Routed Experts | CPU/RAM | nur k von N pro Token aktiv |

Flags in llama.cpp:

```
-ngl 999 --n-cpu-moe N          # N oberste Expert-Layer im RAM
-ngl 999 -ot "exps=CPU"         # alle routed experts im RAM
-ot "blk\.(2[0-9]|3[0-9])\.ffn_.*_exps\.=CPU"   # selektiv per Regex
```

Mehrere `-ot`-Ausdrücke werden kommagetrennt übergeben. Zusätzlich empfohlen: größere Batches (`-b 4096 -ub 4096`), weil der Prefill dann GPU-beschleunigt bleibt.

Größenordnung auf einer 3090: ein 35B-A3B-MoE erreicht in veröffentlichten Messungen ~135 tok/s, ein dichtes 27B liegt bei ~27–31 tok/s. Das Modell ist also größer *und* schneller.

**Dein Budget:** 24 GB VRAM + realistisch ~24 GB nutzbares RAM (34 GB minus OS, Tauri, Chromium, Headroom) ≈ 48 GB. Das reicht für MoE-Modelle der 60–80B-Klasse bei Q4. Für die 120B+-Klasse brauchst du RAM (siehe 2.7).

**Vorbehalt:** MoE spart Rechenzeit, nicht Speicher – alle Experten bleiben resident. Und ein 20–22 GB großes MoE-Q4 lässt auf einer 24-GB-Karte wenig KV-Raum für lange Agentenkontexte. Der Gewinn kommt erst, wenn die Experten bewusst ins RAM gehen.

### 2.2 Nicht Gewichte auslagern, sondern den KV-Cache verkleinern

Der zweitgrößte VRAM-Block bei langen Kontexten ist der KV-Cache.

```
--flash-attn --cache-type-k q8_0 --cache-type-v q8_0
```

halbiert ihn etwa. Das freigewordene VRAM geht direkt in mehr Kontext oder einen größeren Quant – ohne jede Auslagerung. Das ist der günstigste Hebel überhaupt und in deinem Code heute nicht vorhanden.

### 2.3 SSD als Zustandsspeicher statt als Gewichtespeicher

Drei legitime Rollen:

1. **mmap + OS-Page-Cache.** Bei 34 GB RAM und 16,5 GB Modell bleibt das Modell zwischen Neustarts im Page-Cache; der zweite Start liest von RAM statt von der SSD. Dein Code wählt bereits zwischen `--mmap` und `--load-mode none` je nach Speicherdruck.
2. **KV-Cache persistieren.** `--slot-save-path <dir>` erlaubt, den KV-Zustand einer Konversation zu speichern und beim Zurückwechseln zu laden statt neu zu prefillen. Ein 8k-Kontext-KV liegt im Bereich weniger hundert MB – auf NVMe unter einer Sekunde gegenüber 11–23 s Neu-Prefill. Das adressiert exakt dein Projekt-/Chatwechsel-Problem (B-1 in der Hauptanalyse).
3. **Mehrere Modelle vorhalten.** Bei 770 GB frei kein Engpass.

### 2.4 Prefill und Decode getrennt betrachten

Prefill (Prompt-Verarbeitung) ist **rechen**limitiert und parallelisierbar. llama.cpp überträgt dafür auch CPU-residente Gewichte batchweise zur GPU, sobald der Batch groß genug ist (Schwelle über `GGML_OP_OFFLOAD_MIN_BATCH` steuerbar). Das heißt:

- Hybrid-Betrieb kostet vor allem **Decode**, nicht TTFT.
- Bei schmaler PCIe-Anbindung (bei dir PCIe 3.0) kann ein zu niedriger Schwellwert sogar schaden, weil ständig Gewichte hin- und hergeschoben werden.
- Deine Batchplanung (`plan_resources_for_platform`, Profile 128/32, 512/128, 1024/256) ist dafür der richtige Stellhebel; für MoE-Hybrid wären eher 2048–4096 angebracht.

### 2.5 Speculative Decoding – Rechenleistung gegen Bandbreite tauschen

Ein kleines Draft-Modell (0,5–1,5B) erzeugt K Tokens, das große Modell verifiziert sie in **einem** Durchgang. Damit wird pro akzeptiertem Token weniger oft das ganze Modell gelesen – genau die Ressource, die knapp ist.

```
-md <draft.gguf> --draft-max 16 --draft-min 4 --gpu-layers-draft 999
```

Ehrliche Einordnung: Das funktioniert gut bei **dichten** Modellen und strukturierter Ausgabe (Code, JSON, Wiederholungen). Bei MoE mit kleiner aktiver Parameterzahl auf Consumer-Ampere ist es dokumentiert **langsamer** – in einer systematischen Messreihe auf einer 3090 mit 35B-A3B lagen alle 19 getesteten Konfigurationen zwischen −5 % und −39 % unter der Baseline, teilweise trotz 100 % Draft-Akzeptanz. Also: bei deinem dichten 27B messen, niemals ungeprüft aktivieren.

### 2.6 Zweite GPU – der direkteste Weg zu größeren Modellen

2× RTX 3090 = 48 GB VRAM. Ein dichtes 70B-Q4 (~40 GB) läuft dann vollständig im VRAM statt hybrid – also im Bereich 15–20 tok/s statt 2–3 tok/s.

Für deinen Sockel wichtig: Der i9-10900K bietet 16 PCIe-3.0-Lanes, die sich bei zwei Karten auf ×8/×8 aufteilen. Für `--split-mode layer` ist das unkritisch, weil nur Aktivierungen zwischen den Karten wandern (wenige MB pro Token). Für `--split-mode row` wäre es spürbar. Dein `local_model_gpu.rs` kennt `--split-mode layer` und `--tensor-split` bereits und prüft sie gegen die `--help`-Ausgabe.

NVLink ist bei 3090 möglich und hilft bei Row-Split, nicht bei Layer-Split.

### 2.7 RAM-Aufrüstung – mit Vorbehalt

34 → 128 GB vergrößert das MoE-Budget stark. Aber: Auf Z490-Boards fallen vier belegte DIMMs häufig auf DDR4-2666/2933 zurück. Damit sinkt genau die Bandbreite, an der die ausgelagerten Experten hängen. **2× 32 GB (64 GB) bei voller Taktrate ist meist besser als 4× 32 GB bei reduzierter.**

Wenn du auf MoE setzt, ist RAM-Bandbreite die wichtigere Größe als RAM-Kapazität. Ein Plattformwechsel (DDR5 Dual-Channel ~90–100 GB/s, oder Threadripper/EPYC mit 8 Kanälen ~200–400 GB/s) verändert die Rechnung in Abschnitt 1 deutlich stärker als mehr DDR4.

### 2.8 Alternative Laufzeiten

- **ik_llama.cpp** – merklich schnellere CPU-/Hybrid-Pfade für MoE, inkl. Arbeiten an selektivem Expert-Caching im VRAM.
- **KTransformers** – explizit als GPU+CPU-Hybrid für große MoE ausgelegt.
- **vLLM / TensorRT-LLM** – kein sinnvoller CPU-Offload; nur relevant, wenn alles ins VRAM passt.

Für Luczor sind das keine Flags, sondern **neue Artefakte**: dein Sicherheitsmodell pinnt `llama-server.exe` per SHA-256 im signierten Manifest, inklusive Support-Dateien. Ein Runtimewechsel bedeutet neue Hashes, neue Evaluation, neue Freigabe.

---

## 3. Konkrete Einordnung für Luczor

**Ausgangslage:** Dein Modell ist mit 16,5 GiB kleiner als deine 24 GB VRAM. Du betreibst heute also gar keinen Hybrid – und solltest für dieses Modell auch keinen anstreben. Jede Auslagerung würde nur bremsen.

Sinnvolle Reihenfolge:

| Schritt | Maßnahme | Erwartung |
| --- | --- | --- |
| 1 | `--flash-attn` + KV-Q8 (A-2 der Hauptanalyse) | 3–5 GB VRAM frei → 32k Kontext **oder** Q5_K_M (~19,2 GB) bei gleicher Geschwindigkeit |
| 2 | Prompt-Cache + Slot-Save auf SSD (A-1 / B-1) | spart 11–23 s Prefill pro Turn und pro Projektwechsel – mehr als jede Hardwareänderung bringt |
| 3 | MoE-Kandidat evaluieren (im Rahmen P0.2) | größeres Modell bei gleicher oder besserer Decode-Geschwindigkeit |
| 4 | Hardware | zweite 3090 (dichte Modelle bis 70B) **oder** RAM-Bandbreite (MoE) – nicht beides gleichzeitig planen |

**Was Luczor dafür im Code bräuchte:**

- `local_model_gpu.rs::choose_acceleration` – zusätzlich zum `--n-gpu-layers`-Plan einen Tensor-Placement-Plan (`-ot` / `--n-cpu-moe`) erzeugen; die Gerätebudget-Logik und der NVML-Abgleich sind bereits vorhanden.
- `RuntimeOptions::from_help` – neue Flags kapazitätsgeprüft aufnehmen (`--flash-attn`, `--cache-type-k/-v`, `--n-cpu-moe`, `-ot`, `--slot-save-path`, `-md`). Das Muster existiert und hält die Bindung an den signierten Runtime-Hash intakt.
- `CapacityPolicy` – für Hybrid müssen VRAM- und RAM-Schwelle **gemeinsam** geprüft werden; `accelerator_memory_scope` ist als Feld schon da, `min_vram_bytes > 0 && !plan.uses_gpu()` bleibt korrekt, weil ein Hybridplan die GPU nutzt.
- `ModelRelease` – ein Draft-Modell für Speculative Decoding wäre ein **zweites Artefakt mit eigenem SHA-256** im signierten Manifest, nicht nur ein Startargument.
- Benchmarkschwellen (`BenchmarkThresholds`) – für Hybrid- und MoE-Profile getrennte Werte, sonst schlägt die Admission beim ersten Auslagerungsschritt fehl.

---

## 4. Zusammenfassung in einem Satz

Gemeinsam nutzen lassen sich die Ebenen nur für **Kapazität**, nicht für **Tempo** – und genau deshalb ist MoE mit Experten im RAM plus KV-Quantisierung plus persistenter KV-Cache auf SSD der einzige Pfad, der auf deiner Hardware gleichzeitig größere Modelle und brauchbare Geschwindigkeit liefert; alles andere ist ein Tausch, bei dem du Geschwindigkeit verkaufst.
