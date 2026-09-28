//! Frames del stream `/fhs/v1/0.1.0`: longitud varint sin signo + Envelope
//! (lo que escribe `encodeEnvelopeFrame` y lee `it-length-prefixed` en TS).
//!
//! Límites (DEC-0095), iguales en todos los nodos y comprobados sobre el
//! prefijo de longitud antes de reservar memoria:
//! - [`MAX_FRAME_BYTES`] por frame;
//! - un presupuesto global de decodificación ([`DECODE_BUDGET_BYTES`]): cada
//!   frame toma el doble de su longitud (cuerpo + copia decodificada) mientras
//!   se lee, verifica y decodifica;
//! - como máximo [`MAX_BUDGET_WAITERS`] frames esperando el presupuesto, y no
//!   más de [`BUDGET_WAIT`]; si no, el stream se cierra;
//! - [`MAX_INVALID_FRAMES`] frames seguidos con firma inválida cierran el stream.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::LazyLock;
use std::time::Duration;

use futures::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use prost::Message;
use tokio::sync::Semaphore;

use crate::protocol::fhs::Envelope;
use crate::signing;

/// Tope de protocolo para un frame (un adjunto inline de
/// [`MAX_ATTACHMENT_BYTES`] más el resto del mensaje).
pub const MAX_FRAME_BYTES: usize = 33 * 1024 * 1024;
/// Tope de protocolo para un adjunto, inline o leído de IPFS.
pub const MAX_ATTACHMENT_BYTES: usize = 32 * 1024 * 1024;
/// Memoria total que el nodo dedica a frames en decodificación.
pub const DECODE_BUDGET_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_BUDGET_WAITERS: usize = 16;
pub const BUDGET_WAIT: Duration = Duration::from_secs(10);
pub const MAX_INVALID_FRAMES: usize = 5;

/// Unidad del semáforo: KiB, para que el doble de un frame quepa en `u32`.
const BUDGET_UNIT: usize = 1024;

static BUDGET: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(DECODE_BUDGET_BYTES / BUDGET_UNIT));
static WAITERS: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("E/S del stream: {0}")]
    Io(#[from] std::io::Error),
    #[error("frame demasiado grande ({0} bytes)")]
    TooLarge(usize),
    #[error("varint de longitud inválido")]
    BadLength,
    #[error("Envelope inválido: {0}")]
    Decode(#[from] prost::DecodeError),
    #[error("nodo sin presupuesto de decodificación para {0} bytes")]
    Overloaded(usize),
    #[error("{0} frames seguidos con firma inválida")]
    TooManyInvalid(usize),
}

/// Parte del presupuesto global que ocupa un frame hasta decodificarse.
pub struct FramePermit {
    _permit: tokio::sync::SemaphorePermit<'static>,
}

async fn reserve(len: usize) -> Result<FramePermit, FrameError> {
    let units = u32::try_from((2 * len).div_ceil(BUDGET_UNIT).max(1))
        .map_err(|_| FrameError::TooLarge(len))?;
    if let Ok(permit) = BUDGET.try_acquire_many(units) {
        return Ok(FramePermit { _permit: permit });
    }
    if WAITERS.fetch_add(1, Ordering::SeqCst) >= MAX_BUDGET_WAITERS {
        WAITERS.fetch_sub(1, Ordering::SeqCst);
        return Err(FrameError::Overloaded(len));
    }
    let acquired = tokio::time::timeout(BUDGET_WAIT, BUDGET.acquire_many(units)).await;
    WAITERS.fetch_sub(1, Ordering::SeqCst);
    match acquired {
        Ok(Ok(permit)) => Ok(FramePermit { _permit: permit }),
        _ => Err(FrameError::Overloaded(len)),
    }
}

pub async fn write_envelope<W: AsyncWrite + Unpin>(
    writer: &mut W,
    envelope: &Envelope,
) -> Result<(), FrameError> {
    writer
        .write_all(&envelope.encode_length_delimited_to_vec())
        .await?;
    writer.flush().await?;
    Ok(())
}

async fn read_varint<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Option<usize>, FrameError> {
    let mut value: u64 = 0;
    for shift in (0..64).step_by(7) {
        let mut byte = [0u8; 1];
        let n = reader.read(&mut byte).await?;
        if n == 0 {
            return if shift == 0 {
                Ok(None)
            } else {
                Err(FrameError::BadLength)
            };
        }
        value |= u64::from(byte[0] & 0x7f) << shift;
        if byte[0] & 0x80 == 0 {
            return usize::try_from(value)
                .map(Some)
                .map_err(|_| FrameError::BadLength);
        }
    }
    Err(FrameError::BadLength)
}

/// Siguiente frame: `None` al cerrarse el stream. Devuelve los bytes crudos
/// para verificar la firma sobre ellos, con su parte del presupuesto.
pub async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Option<(Vec<u8>, FramePermit)>, FrameError> {
    let Some(len) = read_varint(reader).await? else {
        return Ok(None);
    };
    if len > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(len));
    }
    let permit = reserve(len).await?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    Ok(Some((buf, permit)))
}

/// Siguiente Envelope con firma válida; los frames con firma inválida se
/// descartan con un aviso (como `decodeStream` en el TS), hasta
/// [`MAX_INVALID_FRAMES`] seguidos.
pub async fn read_verified<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Envelope>, FrameError> {
    let mut invalid = 0;
    loop {
        let Some((bytes, _permit)) = read_frame(reader).await? else {
            return Ok(None);
        };
        match signing::verify_envelope_bytes(&bytes)? {
            Some(envelope) => return Ok(Some(envelope)),
            None => {
                invalid += 1;
                tracing::warn!("frame FHS descartado: firma ausente o inválida");
                if invalid >= MAX_INVALID_FRAMES {
                    return Err(FrameError::TooManyInvalid(invalid));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::p2p::{identity::NodeIdentity, wire};
    use crate::protocol::fhs::{envelope::Payload, ChatDeltaMessage};
    use futures::io::Cursor;

    /// Las pruebas comparten el presupuesto global: una a la vez.
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn sealed() -> Envelope {
        let id = NodeIdentity::from_keypair(libp2p::identity::Keypair::generate_ed25519()).unwrap();
        wire::sealed_envelope(
            &id,
            "",
            Payload::ChatDelta(ChatDeltaMessage {
                mission_id: "m".into(),
                delta: "hola".into(),
            }),
        )
    }

    fn varint(mut value: usize) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return out;
            }
            out.push(byte | 0x80);
        }
    }

    #[tokio::test]
    async fn rejects_oversized_frames_from_the_length_prefix() {
        let _serial = SERIAL.lock().await;
        // Solo el prefijo: si reservara memoria o esperara el cuerpo, fallaría
        // con E/S en lugar de TooLarge.
        let mut reader = Cursor::new(varint(MAX_FRAME_BYTES + 1));
        assert!(matches!(
            read_frame(&mut reader).await,
            Err(FrameError::TooLarge(n)) if n == MAX_FRAME_BYTES + 1
        ));
    }

    #[tokio::test]
    async fn closes_after_consecutive_invalid_signatures() {
        let _serial = SERIAL.lock().await;
        let mut forged = sealed();
        forged.signature[0] ^= 0xff;
        let mut buf = Vec::new();
        for _ in 0..MAX_INVALID_FRAMES {
            write_envelope(&mut buf, &forged).await.unwrap();
        }
        write_envelope(&mut buf, &sealed()).await.unwrap();
        let mut reader = Cursor::new(buf);
        assert!(matches!(
            read_verified(&mut reader).await,
            Err(FrameError::TooManyInvalid(n)) if n == MAX_INVALID_FRAMES
        ));

        // Menos de cinco seguidos se descartan y llega el válido.
        let mut buf = Vec::new();
        for _ in 0..MAX_INVALID_FRAMES - 1 {
            write_envelope(&mut buf, &forged).await.unwrap();
        }
        write_envelope(&mut buf, &sealed()).await.unwrap();
        assert!(read_verified(&mut Cursor::new(buf))
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn limits_frames_waiting_for_the_decode_budget() {
        let _serial = SERIAL.lock().await;
        let total = u32::try_from(DECODE_BUDGET_BYTES / BUDGET_UNIT).unwrap();
        let held = BUDGET.acquire_many(total).await.unwrap();
        let mut frame = Vec::new();
        write_envelope(&mut frame, &sealed()).await.unwrap();

        let waiting: Vec<_> = (0..MAX_BUDGET_WAITERS)
            .map(|_| {
                let frame = frame.clone();
                tokio::spawn(async move {
                    read_verified(&mut Cursor::new(frame))
                        .await
                        .map(|e| e.is_some())
                })
            })
            .collect();
        while WAITERS.load(Ordering::SeqCst) < MAX_BUDGET_WAITERS {
            tokio::task::yield_now().await;
        }
        // El 17.º no espera: cierra su stream.
        assert!(matches!(
            read_verified(&mut Cursor::new(frame.clone())).await,
            Err(FrameError::Overloaded(_))
        ));

        drop(held);
        for task in waiting {
            assert!(task.await.unwrap().unwrap());
        }
        assert_eq!(WAITERS.load(Ordering::SeqCst), 0);
        assert_eq!(BUDGET.available_permits(), total as usize);
    }

    #[tokio::test]
    async fn gives_up_after_waiting_too_long_for_the_budget() {
        let _serial = SERIAL.lock().await;
        tokio::time::pause();
        let total = u32::try_from(DECODE_BUDGET_BYTES / BUDGET_UNIT).unwrap();
        let _held = BUDGET.acquire_many(total).await.unwrap();
        let mut frame = Vec::new();
        write_envelope(&mut frame, &sealed()).await.unwrap();
        assert!(matches!(
            read_verified(&mut Cursor::new(frame)).await,
            Err(FrameError::Overloaded(_))
        ));
        assert_eq!(WAITERS.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn writes_and_reads_verified_frames() {
        let _serial = SERIAL.lock().await;
        let id = NodeIdentity::from_keypair(libp2p::identity::Keypair::generate_ed25519()).unwrap();
        let envelope = wire::sealed_envelope(
            &id,
            "",
            Payload::ChatDelta(ChatDeltaMessage {
                mission_id: "m".into(),
                delta: "hola".into(),
            }),
        );
        let mut buf = Vec::new();
        write_envelope(&mut buf, &envelope).await.unwrap();
        write_envelope(&mut buf, &envelope).await.unwrap();
        let mut reader = Cursor::new(buf);
        assert_eq!(
            read_verified(&mut reader)
                .await
                .unwrap()
                .unwrap()
                .message_id,
            envelope.message_id
        );
        assert!(read_verified(&mut reader).await.unwrap().is_some());
        assert!(read_verified(&mut reader).await.unwrap().is_none());
    }
}
