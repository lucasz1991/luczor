//! Same-account LAN transport. Discovery is untrusted; mutual TLS pins server-attested
//! certificates. Receiving only stores an envelope: it never executes a tool or elects a master.
use super::execution::{admit, ExecutionLease, Guarded};
use base64::Engine;
use rsa::{
    pkcs1v15::{Signature, VerifyingKey},
    signature::Verifier,
};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime},
    server::danger::{ClientCertVerified, ClientCertVerifier},
    DigitallySignedStruct, DistinguishedName, SignatureScheme,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
const SERVICE: &str = "_luczor-peer._tcp.local.";
const MAX_FRAME: usize = 12 * 1024 * 1024;
const MAX_PENDING_BYTES: usize = 512 * 1024 * 1024;
const MAX_PENDING_MESSAGES: usize = 10_000;
const KEY_ACCOUNT: &str = "luczor_lan_tls_identity_v1";
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn now() -> Result<i128, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "lan_clock_invalid")?
        .as_millis() as i128)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SignedIdentity {
    protocol_version: u8,
    user_id: u64,
    client_id: String,
    cert_sha256: String,
    issued_at: String,
    expires_at: String,
    algorithm: String,
    signature: String,
}
#[derive(Serialize)]
struct IdentityCanonical<'a> {
    protocol_version: u8,
    user_id: u64,
    client_id: &'a str,
    cert_sha256: &'a str,
    issued_at: &'a str,
    expires_at: &'a str,
}
fn verify_identity(identity: &SignedIdentity) -> Result<(), String> {
    if identity.protocol_version != 1
        || identity.user_id == 0
        || identity.client_id.is_empty()
        || identity.client_id.len() > 300
        || identity.cert_sha256.len() != 64
        || !identity
            .cert_sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || identity.algorithm != "RSA-SHA256"
    {
        return Err("lan_identity_invalid".into());
    }
    let now = now()?;
    let issued = super::device_jobs::parse_rfc3339_millis(&identity.issued_at)?;
    let expires = super::device_jobs::parse_rfc3339_millis(&identity.expires_at)?;
    if issued > now + 60_000 || expires <= now || expires - issued > 7 * 24 * 60 * 60 * 1000 {
        return Err("lan_identity_expired_or_invalid".into());
    }
    let key = super::device_jobs::trusted_device_job_key()?;
    let canonical = serde_json::to_vec(&IdentityCanonical {
        protocol_version: 1,
        user_id: identity.user_id,
        client_id: &identity.client_id,
        cert_sha256: &identity.cert_sha256,
        issued_at: &identity.issued_at,
        expires_at: &identity.expires_at,
    })
    .map_err(|_| "lan_identity_invalid")?;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(&identity.signature)
        .map_err(|_| "lan_identity_signature_invalid")?;
    let signature =
        Signature::try_from(signature.as_slice()).map_err(|_| "lan_identity_signature_invalid")?;
    VerifyingKey::<Sha256>::new(key)
        .verify(&canonical, &signature)
        .map_err(|_| "lan_identity_signature_invalid".into())
}
#[derive(Deserialize, Serialize)]
struct KeyMaterial {
    cert: String,
    key: String,
}
fn key_material(app: &AppHandle) -> Result<KeyMaterial, String> {
    let entry = keyring::Entry::new(&app.config().identifier, KEY_ACCOUNT)
        .map_err(|_| "lan_key_store_unavailable")?;
    match entry.get_password() {
        Ok(value) => serde_json::from_str(&value).map_err(|_| "lan_key_store_invalid".into()),
        Err(keyring::Error::NoEntry) => {
            let generated = rcgen::generate_simple_self_signed(vec!["luczor-peer.local".into()])
                .map_err(|_| "lan_certificate_generation_failed")?;
            let result = KeyMaterial {
                cert: base64::engine::general_purpose::STANDARD.encode(generated.cert.der()),
                key: base64::engine::general_purpose::STANDARD
                    .encode(generated.signing_key.serialize_der()),
            };
            entry
                .set_password(&serde_json::to_string(&result).map_err(|_| "lan_key_store_invalid")?)
                .map_err(|_| "lan_key_store_unavailable")?;
            Ok(result)
        }
        Err(_) => Err("lan_key_store_unavailable".into()),
    }
}
fn certificate(material: &KeyMaterial) -> Result<CertificateDer<'static>, String> {
    Ok(CertificateDer::from(
        base64::engine::general_purpose::STANDARD
            .decode(&material.cert)
            .map_err(|_| "lan_key_store_invalid")?,
    ))
}
fn private_key(material: &KeyMaterial) -> Result<PrivateKeyDer<'static>, String> {
    Ok(PrivatePkcs8KeyDer::from(
        base64::engine::general_purpose::STANDARD
            .decode(&material.key)
            .map_err(|_| "lan_key_store_invalid")?,
    )
    .into())
}
#[derive(Debug)]
struct Pins {
    identities: Vec<SignedIdentity>,
}
impl Pins {
    fn check(&self, cert: &CertificateDer<'_>, time: UnixTime) -> Result<(), rustls::Error> {
        let hash = digest(cert.as_ref());
        let now = i128::from(time.as_secs()) * 1000;
        if self.identities.iter().any(|identity| {
            identity.cert_sha256 == hash
                && super::device_jobs::parse_rfc3339_millis(&identity.expires_at)
                    .is_ok_and(|end| end > now)
        }) {
            Ok(())
        } else {
            Err(rustls::Error::General(
                "unpaired or expired LAN certificate".into(),
            ))
        }
    }
}
fn verify12(
    message: &[u8],
    cert: &CertificateDer<'_>,
    signature: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, rustls::Error> {
    rustls::crypto::verify_tls12_signature(
        message,
        cert,
        signature,
        &rustls::crypto::ring::default_provider().signature_verification_algorithms,
    )
}
fn verify13(
    message: &[u8],
    cert: &CertificateDer<'_>,
    signature: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, rustls::Error> {
    rustls::crypto::verify_tls13_signature(
        message,
        cert,
        signature,
        &rustls::crypto::ring::default_provider().signature_verification_algorithms,
    )
}
impl ServerCertVerifier for Pins {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        self.check(cert, now)?;
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify12(m, c, s)
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify13(m, c, s)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
impl ClientCertVerifier for Pins {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }
    fn verify_client_cert(
        &self,
        cert: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        self.check(cert, now)?;
        Ok(ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify12(m, c, s)
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify13(m, c, s)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    id: String,
    from_device_id: String,
    to_device_id: String,
    kind: EnvelopeKind,
    payload: Value,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum EnvelopeKind {
    Job,
    Result,
    Chunk,
    Progress,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Start {
    principal_id: String,
    device_id: String,
    signed_identity: SignedIdentity,
    peers: Vec<SignedIdentity>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Send {
    principal_id: String,
    target_device_id: String,
    envelope: Envelope,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueRequest {
    principal_id: String,
    #[serde(default)]
    ids: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    active: bool,
    device_id: Option<String>,
    port: Option<u16>,
    peers: Vec<String>,
}
struct PeerState {
    principal: String,
    device: String,
    identity: SignedIdentity,
    peers: Vec<SignedIdentity>,
    port: u16,
    stop: Arc<AtomicBool>,
    addresses: Arc<Mutex<BTreeMap<String, SocketAddr>>>,
    database: PathBuf,
    material: KeyMaterial,
    lease: ExecutionLease,
    mdns: mdns_sd::ServiceDaemon,
}
impl Drop for PeerState {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.mdns.shutdown();
    }
}
static PEER: OnceLock<Mutex<Option<Arc<PeerState>>>> = OnceLock::new();
static SESSION_GENERATION: AtomicUsize = AtomicUsize::new(0);
fn peer(principal: &str) -> Result<Arc<PeerState>, String> {
    let active = PEER
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "lan_state_unavailable")?
        .clone()
        .ok_or("lan_not_started")?;
    if active.principal != principal || active.stop.load(Ordering::Acquire) {
        return Err("lan_owner_mismatch".into());
    }
    active.lease.check()?;
    verify_identity(&active.identity)?;
    Ok(active)
}
fn db(path: &PathBuf) -> Result<rusqlite::Connection, String> {
    let connection = rusqlite::Connection::open(path).map_err(|_| "lan_queue_unavailable")?;
    connection
        .busy_timeout(Duration::from_secs(3))
        .map_err(|_| "lan_queue_unavailable")?;
    connection.execute_batch("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS messages(direction TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,body BLOB NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(direction,id));").map_err(|_|"lan_queue_unavailable")?;
    Ok(connection)
}
fn store(path: &PathBuf, direction: &str, envelope: &Envelope) -> Result<(), String> {
    if uuid::Uuid::parse_str(&envelope.id)
        .map(|id| id.to_string() != envelope.id)
        .unwrap_or(true)
    {
        return Err("lan_message_id_invalid".into());
    }
    let bytes = serde_json::to_vec(envelope).map_err(|_| "lan_message_invalid")?;
    if bytes.len() > MAX_FRAME {
        return Err("lan_message_too_large".into());
    }
    let mut connection = db(path)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "lan_queue_write_failed")?;
    let hash = digest(&bytes);
    let previous = transaction.query_row(
        "SELECT digest FROM messages WHERE direction=?1 AND id=?2",
        rusqlite::params![direction, envelope.id],
        |row| row.get::<_, String>(0),
    );
    match previous {
        Ok(previous) if previous == hash => return Ok(()),
        Ok(_) => return Err("lan_message_id_conflict".into()),
        Err(rusqlite::Error::QueryReturnedNoRows) => {}
        Err(_) => return Err("lan_queue_read_failed".into()),
    }
    let (count, size): (i64, i64) = transaction
        .query_row(
            "SELECT COUNT(*),COALESCE(SUM(length(body)),0) FROM messages WHERE delivered=0",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "lan_queue_read_failed")?;
    if count >= MAX_PENDING_MESSAGES as i64
        || size.saturating_add(bytes.len() as i64) > MAX_PENDING_BYTES as i64
    {
        return Err("lan_queue_capacity_reached".into());
    }
    transaction
        .execute(
            "INSERT INTO messages(direction,id,digest,body)VALUES(?1,?2,?3,?4)",
            rusqlite::params![direction, envelope.id, hash, bytes],
        )
        .map_err(|_| "lan_queue_commit_failed")?;
    transaction
        .commit()
        .map_err(|_| "lan_queue_commit_failed")?;
    Ok(())
}

/// One absolute deadline also bounds fragmented TLS handshakes and slow-drip peers.
struct DeadlineSocket {
    stream: TcpStream,
    end: Instant,
}
impl DeadlineSocket {
    fn new(stream: TcpStream) -> Self {
        Self {
            stream,
            end: Instant::now() + Duration::from_secs(25),
        }
    }
    fn remaining(&self) -> std::io::Result<Duration> {
        self.end
            .checked_duration_since(Instant::now())
            .filter(|value| !value.is_zero())
            .map(|value| value.min(Duration::from_secs(10)))
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::TimedOut, "LAN transfer deadline")
            })
    }
}
impl Read for DeadlineSocket {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        self.stream.set_read_timeout(Some(self.remaining()?))?;
        self.stream.read(bytes)
    }
}
impl Write for DeadlineSocket {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}
fn read_frame(reader: &mut impl Read) -> Result<Vec<u8>, String> {
    let mut header = [0; 4];
    reader
        .read_exact(&mut header)
        .map_err(|_| "lan_frame_read_failed")?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err("lan_frame_size_invalid".into());
    }
    let mut bytes = vec![0; length];
    reader
        .read_exact(&mut bytes)
        .map_err(|_| "lan_frame_read_failed")?;
    Ok(bytes)
}
fn write_frame(writer: &mut impl Write, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err("lan_frame_size_invalid".into());
    }
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| writer.write_all(bytes))
        .and_then(|_| writer.flush())
        .map_err(|_| "lan_frame_write_failed".into())
}
fn receive(
    stream: TcpStream,
    state: Arc<PeerState>,
    config: Arc<rustls::ServerConfig>,
    app: AppHandle,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|_| "lan_socket_failed")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|_| "lan_socket_failed")?;
    let connection = rustls::ServerConnection::new(config).map_err(|_| "lan_tls_unavailable")?;
    let mut tls = rustls::StreamOwned::new(connection, DeadlineSocket::new(stream));
    let bytes = read_frame(&mut tls)?;
    let presented = tls
        .conn
        .peer_certificates()
        .and_then(|certs| certs.first())
        .ok_or("lan_peer_certificate_missing")?;
    let fingerprint = digest(presented.as_ref());
    let identity = state
        .peers
        .iter()
        .find(|identity| identity.cert_sha256 == fingerprint)
        .ok_or("lan_peer_unpaired")?;
    verify_identity(identity)?;
    let envelope: Envelope = serde_json::from_slice(&bytes).map_err(|_| "lan_message_invalid")?;
    if envelope.from_device_id != identity.client_id
        || envelope.to_device_id != state.device
        || identity.user_id != state.identity.user_id
    {
        return Err("lan_message_owner_mismatch".into());
    }
    if state.stop.load(Ordering::Acquire) {
        return Err("lan_stopped".into());
    }
    state.lease.check()?;
    store(&state.database, "in", &envelope)?;
    write_frame(
        &mut tls,
        &serde_json::to_vec(&serde_json::json!({"accepted":true,"id":envelope.id}))
            .map_err(|_| "lan_message_invalid")?,
    )?;
    let _=app.emit_to("main","luczor://lan-message",serde_json::json!({"principalId":state.principal,"id":envelope.id,"fromDeviceId":envelope.from_device_id}));
    Ok(())
}
fn connect_send(state: &PeerState, envelope: &Envelope) -> Result<(), String> {
    if state.stop.load(Ordering::Acquire) {
        return Err("lan_stopped".into());
    }
    state.lease.check()?;
    verify_identity(&state.identity)?;
    let identity = state
        .peers
        .iter()
        .find(|identity| identity.client_id == envelope.to_device_id)
        .ok_or("lan_peer_unpaired")?;
    verify_identity(identity)?;
    let address = *state
        .addresses
        .lock()
        .map_err(|_| "lan_discovery_unavailable")?
        .get(&identity.client_id)
        .ok_or("lan_peer_offline")?;
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .map_err(|_| "lan_tls_unavailable")?
    .dangerous()
    .with_custom_certificate_verifier(Arc::new(Pins {
        identities: vec![identity.clone()],
    }))
    .with_client_auth_cert(
        vec![certificate(&state.material)?],
        private_key(&state.material)?,
    )
    .map_err(|_| "lan_tls_unavailable")?;
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|_| "lan_peer_offline")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|_| "lan_socket_failed")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|_| "lan_socket_failed")?;
    let connection = rustls::ClientConnection::new(
        Arc::new(config),
        ServerName::try_from("luczor-peer.local").map_err(|_| "lan_tls_unavailable")?,
    )
    .map_err(|_| "lan_tls_unavailable")?;
    let mut tls = rustls::StreamOwned::new(connection, DeadlineSocket::new(stream));
    write_frame(
        &mut tls,
        &serde_json::to_vec(envelope).map_err(|_| "lan_message_invalid")?,
    )?;
    let ack: Value =
        serde_json::from_slice(&read_frame(&mut tls)?).map_err(|_| "lan_ack_invalid")?;
    if ack["accepted"] != true || ack["id"].as_str() != Some(&envelope.id) {
        return Err("lan_ack_invalid".into());
    }
    db(&state.database)?
        .execute(
            "UPDATE messages SET delivered=1,body=X'' WHERE direction='out'AND id=?1",
            [&envelope.id],
        )
        .map_err(|_| "lan_queue_commit_failed")?;
    Ok(())
}

#[tauri::command]
pub async fn lan_peer_identity(
    app: AppHandle,
    window: super::CallerWebview,
) -> Result<Value, String> {
    super::ensure_main_webview(&window)?;
    tauri::async_runtime::spawn_blocking(move||{let material=key_material(&app)?;Ok(serde_json::json!({"certSha256":digest(certificate(&material)?.as_ref()),"protocolVersion":1}))}).await.map_err(|_|"lan_worker_failed")?
}
#[tauri::command]
pub async fn lan_peer_start(
    app: AppHandle,
    window: super::CallerWebview,
    payload: Guarded<Start>,
) -> Result<Status, String> {
    super::ensure_main_webview(&window)?;
    let lease = admit(&payload.execution, false)?;
    let generation = SESSION_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    tauri::async_runtime::spawn_blocking(move||{
        let request=payload.request;verify_identity(&request.signed_identity)?;
        if request.principal_id.trim().is_empty()||request.principal_id.len()>300||request.device_id!=request.signed_identity.client_id||request.peers.len()>256{return Err("lan_session_identity_invalid".into());}
        let material=key_material(&app)?;if digest(certificate(&material)?.as_ref())!=request.signed_identity.cert_sha256{return Err("lan_certificate_attestation_mismatch".into());}
        let mut unique=std::collections::HashSet::new();for identity in &request.peers{verify_identity(identity)?;if identity.user_id!=request.signed_identity.user_id||!unique.insert(&identity.client_id){return Err("lan_cross_account_peer_rejected".into());}}
        let listener=TcpListener::bind("0.0.0.0:0").map_err(|_|"lan_listener_unavailable")?;listener.set_nonblocking(true).map_err(|_|"lan_listener_unavailable")?;let port=listener.local_addr().map_err(|_|"lan_listener_unavailable")?.port();
        let directory=app.path().app_local_data_dir().map_err(|_|"lan_queue_unavailable")?.join("lan-peers").join(digest(request.principal_id.as_bytes()));std::fs::create_dir_all(&directory).map_err(|_|"lan_queue_unavailable")?;let database=directory.join("queue.sqlite3");db(&database)?;
        let mdns=mdns_sd::ServiceDaemon::new().map_err(|_|"lan_discovery_unavailable")?;let public_id=digest(request.device_id.as_bytes());let properties=[("device",public_id.as_str()),("protocol","1")];
        let info=mdns_sd::ServiceInfo::new(SERVICE,&public_id[..24],&format!("luczor-{}.local.",&public_id[..24]),"",port,&properties[..]).map_err(|_|"lan_discovery_unavailable")?.enable_addr_auto();mdns.register(info).map_err(|_|"lan_discovery_unavailable")?;let discovered=mdns.browse(SERVICE).map_err(|_|"lan_discovery_unavailable")?;
        let config=rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider())).with_protocol_versions(&[&rustls::version::TLS13]).map_err(|_|"lan_tls_unavailable")?.with_client_cert_verifier(Arc::new(Pins{identities:request.peers.clone()})).with_single_cert(vec![certificate(&material)?],private_key(&material)?).map_err(|_|"lan_tls_unavailable")?;
        let state=Arc::new(PeerState{principal:request.principal_id,device:request.device_id,identity:request.signed_identity,peers:request.peers,port,stop:Arc::new(AtomicBool::new(false)),addresses:Arc::new(Mutex::new(BTreeMap::new())),database,material,lease,mdns});
        state.lease.check()?;
        let mut current=PEER.get_or_init(Mutex::default).lock().map_err(|_|"lan_state_unavailable")?;if SESSION_GENERATION.load(Ordering::Acquire)!=generation{return Err("lan_session_changed".into());}if let Some(old)=current.take(){old.stop.store(true,Ordering::Release);let _=old.mdns.shutdown();}*current=Some(state.clone());drop(current);
        let discovery_state=state.clone();std::thread::spawn(move||{while !discovery_state.stop.load(Ordering::Acquire){if let Ok(mdns_sd::ServiceEvent::ServiceResolved(info))=discovered.recv_timeout(Duration::from_secs(1)){if let Some(device)=info.get_property_val_str("device"){if let Some(identity)=discovery_state.peers.iter().find(|identity|digest(identity.client_id.as_bytes())==device){if let Some(address)=info.get_addresses_v4().into_iter().find(|ip|ip.is_private()||ip.is_link_local()||ip.is_loopback()){if let Ok(mut addresses)=discovery_state.addresses.lock(){addresses.insert(identity.client_id.to_string(),SocketAddr::new(IpAddr::V4(address),info.get_port()));}}}}}}});
        let server_state=state.clone();let config=Arc::new(config);std::thread::spawn(move||{let active=Arc::new(AtomicUsize::new(0));while !server_state.stop.load(Ordering::Acquire){match listener.accept(){Ok((stream,address))=>{if !matches!(address.ip(),IpAddr::V4(ip)if ip.is_private()||ip.is_link_local()||ip.is_loopback())||active.load(Ordering::Acquire)>=8{continue;}active.fetch_add(1,Ordering::AcqRel);let count=active.clone();let state=server_state.clone();let config=config.clone();let app=app.clone();std::thread::spawn(move||{let _=receive(stream,state,config,app);count.fetch_sub(1,Ordering::AcqRel);});},Err(error)if error.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(100)),Err(_)=>break}}});
        Ok(Status{active:true,device_id:Some(state.device.clone()),port:Some(port),peers:vec![]})
    }).await.map_err(|_|"lan_worker_failed")?
}
#[tauri::command]
pub fn lan_peer_stop(window: super::CallerWebview) -> Result<(), String> {
    super::ensure_main_webview(&window)?;
    SESSION_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Some(state) = PEER
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "lan_state_unavailable")?
        .take()
    {
        state.stop.store(true, Ordering::Release);
        let _ = state.mdns.shutdown();
    }
    Ok(())
}
#[tauri::command]
pub fn lan_peer_status(
    window: super::CallerWebview,
    payload: QueueRequest,
) -> Result<Status, String> {
    super::ensure_main_webview(&window)?;
    let state = peer(&payload.principal_id)?;
    let peers = state
        .addresses
        .lock()
        .map_err(|_| "lan_discovery_unavailable")?
        .keys()
        .cloned()
        .collect();
    Ok(Status {
        active: true,
        device_id: Some(state.device.clone()),
        port: Some(state.port),
        peers,
    })
}
#[tauri::command]
pub async fn lan_peer_send(window: super::CallerWebview, payload: Send) -> Result<Value, String> {
    super::ensure_main_webview(&window)?;
    let state = peer(&payload.principal_id)?;
    if payload.envelope.from_device_id != state.device
        || payload.target_device_id != payload.envelope.to_device_id
        || !state
            .peers
            .iter()
            .any(|identity| identity.client_id == payload.target_device_id)
    {
        return Err("lan_message_target_invalid".into());
    }
    tauri::async_runtime::spawn_blocking(move||{store(&state.database,"out",&payload.envelope)?;match connect_send(&state,&payload.envelope){Ok(())=>Ok(serde_json::json!({"id":payload.envelope.id,"delivered":true,"queued":false})),Err(reason)=>Ok(serde_json::json!({"id":payload.envelope.id,"delivered":false,"queued":true,"reason":reason}))}}).await.map_err(|_|"lan_worker_failed")?
}
#[tauri::command]
pub async fn lan_peer_drain(
    window: super::CallerWebview,
    payload: QueueRequest,
) -> Result<Vec<Envelope>, String> {
    super::ensure_main_webview(&window)?;
    let state = peer(&payload.principal_id)?;
    tauri::async_runtime::spawn_blocking(move||{let connection=db(&state.database)?;let mut statement=connection.prepare("SELECT body FROM messages WHERE direction='in' AND delivered=0 ORDER BY rowid LIMIT 10").map_err(|_|"lan_queue_read_failed")?;let rows=statement.query_map([],|row|row.get::<_,Vec<u8>>(0)).map_err(|_|"lan_queue_read_failed")?;let mut result=Vec::new();let mut bytes=0;for row in rows{let body=row.map_err(|_|"lan_queue_read_failed")?;if bytes+body.len()>MAX_FRAME&&!result.is_empty(){break;}bytes+=body.len();result.push(serde_json::from_slice(&body).map_err(|_|"lan_queue_invalid")?);}Ok(result)}).await.map_err(|_|"lan_worker_failed")?
}
#[tauri::command]
pub fn lan_peer_ack(window: super::CallerWebview, payload: QueueRequest) -> Result<(), String> {
    super::ensure_main_webview(&window)?;
    let state = peer(&payload.principal_id)?;
    if payload.ids.len() > 100 {
        return Err("lan_ack_invalid".into());
    }
    let mut connection = db(&state.database)?;
    let transaction = connection
        .transaction()
        .map_err(|_| "lan_queue_write_failed")?;
    for id in payload.ids {
        transaction
            .execute(
                "UPDATE messages SET delivered=1,body=X'' WHERE direction='in'AND id=?1",
                [id],
            )
            .map_err(|_| "lan_queue_write_failed")?;
    }
    transaction
        .commit()
        .map_err(|_| "lan_queue_commit_failed".into())
}
#[tauri::command]
pub async fn lan_peer_flush(
    window: super::CallerWebview,
    payload: QueueRequest,
) -> Result<usize, String> {
    super::ensure_main_webview(&window)?;
    let state = peer(&payload.principal_id)?;
    tauri::async_runtime::spawn_blocking(move||{let connection=db(&state.database)?;let mut statement=connection.prepare("SELECT body FROM messages WHERE direction='out'AND delivered=0 ORDER BY rowid LIMIT 10").map_err(|_|"lan_queue_read_failed")?;let rows=statement.query_map([],|row|row.get::<_,Vec<u8>>(0)).map_err(|_|"lan_queue_read_failed")?;let mut delivered=0;for row in rows{let envelope=serde_json::from_slice(&row.map_err(|_|"lan_queue_read_failed")?).map_err(|_|"lan_queue_invalid")?;if connect_send(&state,&envelope).is_ok(){delivered+=1;}}Ok(delivered)}).await.map_err(|_|"lan_worker_failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_frames_are_rejected_before_allocation() {
        let mut bytes = std::io::Cursor::new(((MAX_FRAME + 1) as u32).to_be_bytes());
        assert!(read_frame(&mut bytes).is_err());
    }
    #[test]
    fn durable_inbox_deduplicates_exact_messages_and_rejects_changed_payload() {
        let path =
            std::env::temp_dir().join(format!("luczor-lan-test-{}.sqlite3", uuid::Uuid::new_v4()));
        let mut envelope = Envelope {
            id: uuid::Uuid::new_v4().to_string(),
            from_device_id: "a".into(),
            to_device_id: "b".into(),
            kind: EnvelopeKind::Result,
            payload: serde_json::json!({"ok":true}),
        };
        store(&path, "in", &envelope).unwrap();
        store(&path, "in", &envelope).unwrap();
        envelope.payload = serde_json::json!({"ok":false});
        assert_eq!(
            store(&path, "in", &envelope).unwrap_err(),
            "lan_message_id_conflict"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn acknowledged_payload_is_freed_but_replay_identity_survives() {
        let path =
            std::env::temp_dir().join(format!("luczor-lan-test-{}.sqlite3", uuid::Uuid::new_v4()));
        let envelope = Envelope {
            id: uuid::Uuid::new_v4().to_string(),
            from_device_id: "a".into(),
            to_device_id: "b".into(),
            kind: EnvelopeKind::Chunk,
            payload: serde_json::json!({"data":"private"}),
        };
        store(&path, "in", &envelope).unwrap();
        {
            let db = db(&path).unwrap();
            db.execute(
                "UPDATE messages SET delivered=1,body=X'' WHERE id=?1",
                [&envelope.id],
            )
            .unwrap();
        }
        store(&path, "in", &envelope).unwrap();
        {
            let db = db(&path).unwrap();
            let (count, bytes): (i64, i64) = db
                .query_row(
                    "SELECT COUNT(*),SUM(length(body)) FROM messages",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!((count, bytes), (1, 0));
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn concurrent_identical_deliveries_commit_once() {
        let path =
            std::env::temp_dir().join(format!("luczor-lan-test-{}.sqlite3", uuid::Uuid::new_v4()));
        drop(db(&path).unwrap());
        let envelope = Envelope {
            id: uuid::Uuid::new_v4().to_string(),
            from_device_id: "a".into(),
            to_device_id: "b".into(),
            kind: EnvelopeKind::Result,
            payload: serde_json::json!({"ok":true}),
        };
        let handles = (0..4)
            .map(|_| {
                let path = path.clone();
                let envelope = envelope.clone();
                std::thread::spawn(move || store(&path, "in", &envelope))
            })
            .collect::<Vec<_>>();
        for thread in handles {
            thread.join().unwrap().unwrap();
        }
        {
            let db = db(&path).unwrap();
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM messages", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        std::fs::remove_file(path).unwrap();
    }

    fn test_material() -> KeyMaterial {
        let generated =
            rcgen::generate_simple_self_signed(vec!["luczor-peer.local".into()]).unwrap();
        KeyMaterial {
            cert: base64::engine::general_purpose::STANDARD.encode(generated.cert.der()),
            key: base64::engine::general_purpose::STANDARD
                .encode(generated.signing_key.serialize_der()),
        }
    }
    fn test_pin(material: &KeyMaterial, expires_at: &str) -> SignedIdentity {
        SignedIdentity {
            protocol_version: 1,
            user_id: 1,
            client_id: "device".into(),
            cert_sha256: digest(certificate(material).unwrap().as_ref()),
            issued_at: "2026-01-01T00:00:00Z".into(),
            expires_at: expires_at.into(),
            algorithm: "RSA-SHA256".into(),
            signature: "test-pins-already-validated-at-session-start".into(),
        }
    }
    fn tls_exchange(trust_client: bool, trust_server: bool, expires_at: &str) -> (bool, bool) {
        let client = test_material();
        let server = test_material();
        let foreign = test_material();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_client_cert_verifier(Arc::new(Pins {
            identities: vec![test_pin(
                if trust_client { &client } else { &foreign },
                expires_at,
            )],
        }))
        .with_single_cert(
            vec![certificate(&server).unwrap()],
            private_key(&server).unwrap(),
        )
        .unwrap();
        let client_config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pins {
            identities: vec![test_pin(
                if trust_server { &server } else { &foreign },
                expires_at,
            )],
        }))
        .with_client_auth_cert(
            vec![certificate(&client).unwrap()],
            private_key(&client).unwrap(),
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let receive = std::thread::spawn(move || {
            let stream = listener.accept().unwrap().0;
            let mut tls = rustls::StreamOwned::new(
                rustls::ServerConnection::new(Arc::new(config)).unwrap(),
                DeadlineSocket::new(stream),
            );
            read_frame(&mut tls)
                .and_then(|body| {
                    if body != b"exact test payload" {
                        return Err("bad test payload".into());
                    }
                    write_frame(&mut tls, b"ack")
                })
                .is_ok()
        });
        let stream = TcpStream::connect_timeout(&address, Duration::from_secs(3)).unwrap();
        let mut tls = rustls::StreamOwned::new(
            rustls::ClientConnection::new(
                Arc::new(client_config),
                ServerName::try_from("luczor-peer.local").unwrap(),
            )
            .unwrap(),
            DeadlineSocket::new(stream),
        );
        let sent = write_frame(&mut tls, b"exact test payload")
            .and_then(|_| read_frame(&mut tls))
            .is_ok();
        drop(tls);
        (sent, receive.join().unwrap())
    }
    #[test]
    fn mutual_tls_accepts_exact_pins_and_rejects_wrong_or_expired_certificates() {
        assert_eq!(
            tls_exchange(true, true, "2099-01-01T00:00:00Z"),
            (true, true)
        );
        assert_eq!(
            tls_exchange(false, true, "2099-01-01T00:00:00Z"),
            (false, false)
        );
        assert_eq!(
            tls_exchange(true, false, "2099-01-01T00:00:00Z"),
            (false, false)
        );
        assert_eq!(
            tls_exchange(true, true, "2000-01-01T00:00:00Z"),
            (false, false)
        );
    }
}
