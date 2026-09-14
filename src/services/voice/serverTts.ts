import { createCorrelationId, LuczorApiError, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import { apiTransportFetch } from '@/services/api/transportTarget'
import { validSpeechVoiceId } from './voiceCatalog'

export const MAX_TTS_TEXT_CHARS = 4000
export const MAX_TTS_AUDIO_BYTES = 16 * 1024 * 1024
export const TTS_TIMEOUT_MS = 160_000

function retryDelay(response: Response): number | null {
  if (response.redirected || ![429, 503].includes(response.status)) return null
  // The Luczor speech endpoint advertises transient overload with seconds.
  // No retry on unknown/configuration errors, nor before a longer server delay.
  const value = response.headers.get('Retry-After')?.trim()
  if (!value || !/^\d{1,8}$/.test(value)) return null
  const delay = Number(value) * 1000
  return delay <= 30_000 ? Math.max(250, delay) : null
}

export function speechAbortError(): Error {
  const error = new Error('Sprachausgabe abgebrochen.')
  error.name = 'AbortError'
  return error
}

function endpoint(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new LuczorApiError(0, 'Die Server-URL für die Sprachausgabe ist ungültig (Einstellungen → Server).')
  }
  const localDevelopment =
    import.meta.env.DEV && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:'
  if ((url.protocol !== 'https:' && !localDevelopment) || url.username || url.password || url.search || url.hash) {
    throw new LuczorApiError(0, 'Die Sprachausgabe benötigt eine gültige HTTPS-Server-URL.')
  }
  return `${url.href.replace(/\/+$/u, '')}/api/v1/voice/tts`
}

function serverError(status: number, correlationId: string): LuczorApiError {
  let message = `Server-Sprachausgabe fehlgeschlagen (HTTP ${status}).`
  if (status === 401) message = 'Der Device-Key für die Sprachausgabe ist ungültig (Einstellungen → Server).'
  if (status === 403) message = 'Dieser Device-Key ist nicht für die Server-Sprachausgabe freigegeben.'
  if (status === 404) message = 'Die Server-Sprachausgabe ist auf diesem Luczor-Server noch nicht installiert.'
  if (status === 422) message = 'Der Server hat die Sprachanfrage abgelehnt. Bitte Text und Geschwindigkeit prüfen.'
  if (status === 429) message = 'Der Sprachdienst ist ausgelastet. Bitte kurz warten und erneut versuchen.'
  if (status >= 500) message = 'Der gemeinsame Sprachdienst ist momentan nicht verfügbar. Bitte erneut versuchen.'
  return new LuczorApiError(status, message, correlationId)
}

/** Binary audio uses the captured Luczor identity; service credentials never enter the desktop. */
export async function serverTts(
  text: string,
  config: LuczorApiConfigSnapshot,
  options: { signal?: AbortSignal; speed?: number; voiceId?: string } = {}
): Promise<Blob> {
  if (options.signal?.aborted) throw speechAbortError()
  const clean = text.trim()
  if (!clean || clean.length > MAX_TTS_TEXT_CHARS) {
    throw new LuczorApiError(0, `Ein Sprachabschnitt muss 1 bis ${MAX_TTS_TEXT_CHARS} Zeichen enthalten.`)
  }
  const speed = options.speed ?? 1
  const voiceId = options.voiceId?.trim()
  if (voiceId && !validSpeechVoiceId(voiceId)) throw new LuczorApiError(0, 'Die ausgewählte Stimmen-ID ist ungültig.')
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new LuczorApiError(0, 'Die Sprechgeschwindigkeit muss zwischen 0,5 und 2 liegen.')
  }
  const url = endpoint(config.baseUrl)
  if (!config.deviceKey.trim()) {
    throw new LuczorApiError(0, 'Für die Server-Sprachausgabe fehlt der Device-Key (Einstellungen → Server).')
  }
  const correlationId = createCorrelationId()
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let rejectCancellation: (error: Error) => void = () => undefined
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const cancel = (error: Error) => {
    controller.abort()
    void reader?.cancel().catch(() => undefined)
    rejectCancellation(error)
  }
  const callerAbort = () => cancel(speechAbortError())
  options.signal?.addEventListener('abort', callerAbort, { once: true })
  const timeout = globalThis.setTimeout(
    () => cancel(new LuczorApiError(0, 'Die Server-Sprachausgabe hat zu lange gedauert.', correlationId)),
    TTS_TIMEOUT_MS
  )

  try {
    const operation = (async () => {
      const fetchAudio = () =>
        apiTransportFetch(url, {
          method: 'POST',
          headers: {
            Accept: 'audio/wav',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.deviceKey}`,
            'X-Luczor-Correlation-Id': correlationId,
          },
          body: JSON.stringify({
            text: clean,
            language: 'de',
            speed,
            ...(voiceId && voiceId !== 'piper' ? { voice_id: voiceId } : {}),
          }),
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
        })
      let response = await fetchAudio()
      const delay = retryDelay(response)
      if (!controller.signal.aborted && delay !== null) {
        void response.body?.cancel().catch(() => undefined)
        await Promise.race([
          new Promise<void>(resolve => {
            retryTimer = globalThis.setTimeout(resolve, delay)
          }),
          cancellation,
        ])
        if (controller.signal.aborted) throw speechAbortError()
        // One retry only, with the same captured account/voice and hard deadline.
        response = await fetchAudio()
      }
      const rejectResponse = (error: Error): never => {
        void response.body?.cancel().catch(() => undefined)
        throw error
      }
      if (controller.signal.aborted) return rejectResponse(speechAbortError())
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        return rejectResponse(new LuczorApiError(0, 'Server-Redirects sind für die Sprachausgabe nicht zulässig.'))
      }
      if (!response.ok) return rejectResponse(serverError(response.status, correlationId))
      const mime = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
      if (mime !== 'audio/wav' && mime !== 'audio/x-wav') {
        return rejectResponse(new LuczorApiError(0, 'Der Sprachdienst hat keine WAV-Audiodatei geliefert.'))
      }
      if (Number(response.headers.get('Content-Length')) > MAX_TTS_AUDIO_BYTES) {
        return rejectResponse(new LuczorApiError(0, 'Die Audiodatei überschreitet das Größenlimit von 16 MiB.'))
      }
      if (!response.body) throw new LuczorApiError(0, 'Der Sprachdienst hat eine leere Audiodatei geliefert.')
      reader = response.body.getReader()
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let bytes = 0
      while (true) {
        const { done, value } = await Promise.race([reader.read(), cancellation])
        if (controller.signal.aborted) throw speechAbortError()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_TTS_AUDIO_BYTES) {
          void reader.cancel().catch(() => undefined)
          throw new LuczorApiError(0, 'Die Audiodatei überschreitet das Größenlimit von 16 MiB.')
        }
        chunks.push(new Uint8Array(value))
      }
      if (!bytes) throw new LuczorApiError(0, 'Der Sprachdienst hat eine leere Audiodatei geliefert.')
      const audio = new Blob(chunks, { type: 'audio/wav' })
      const signature = new Uint8Array(await audio.slice(0, 12).arrayBuffer())
      if (
        signature.length < 12 ||
        new TextDecoder().decode(signature.subarray(0, 4)) !== 'RIFF' ||
        new TextDecoder().decode(signature.subarray(8, 12)) !== 'WAVE'
      ) {
        throw new LuczorApiError(0, 'Der Sprachdienst hat ungültige WAV-Audiodaten geliefert.')
      }
      return audio
    })()
    return await Promise.race([operation, cancellation])
  } catch (error) {
    if (options.signal?.aborted) throw speechAbortError()
    if (error instanceof LuczorApiError) throw error
    // Network and upstream response details can contain URLs, request text or credentials.
    throw new LuczorApiError(0, 'Keine Verbindung zum Sprachdienst. Bitte Server und Netzwerk prüfen.', correlationId)
  } finally {
    globalThis.clearTimeout(timeout)
    if (retryTimer !== undefined) globalThis.clearTimeout(retryTimer)
    options.signal?.removeEventListener('abort', callerAbort)
    try {
      reader?.releaseLock()
    } catch {
      // A non-conforming reader may still be pending after the hard deadline.
    }
  }
}
