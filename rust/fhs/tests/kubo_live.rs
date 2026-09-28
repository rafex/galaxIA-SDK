//! Contra un Kubo real (DEC-0095). Se omite salvo que se definan:
//!   FHS_KUBO_API_URL     p. ej. http://127.0.0.1:15001 (túnel SSH)
//!   FHS_KUBO_TOKEN_FILE  archivo con el token del Navigator
//! Ejemplo:
//!   ssh -N -L 15001:127.0.0.1:5001 rafex@192.168.1.139 &
//!   FHS_KUBO_API_URL=http://127.0.0.1:15001 FHS_KUBO_TOKEN_FILE=… \
//!     cargo test --all-features --test kubo_live
#![cfg(feature = "ipfs")]

use galaxia_fhs::ipfs::KuboClient;

fn client() -> Option<KuboClient> {
    let url = std::env::var("FHS_KUBO_API_URL").ok()?;
    let token = std::env::var("FHS_KUBO_TOKEN_FILE").ok()?;
    Some(KuboClient::new(&url, token.as_ref()).expect("cliente Kubo"))
}

#[tokio::test]
async fn only_hash_and_real_add_agree_for_every_size() {
    let Some(kubo) = client() else {
        eprintln!("sin FHS_KUBO_API_URL: se omite");
        return;
    };
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    for size in [0usize, 1, 262_144, 262_145, 20 * 1024 * 1024] {
        // Contenido nuevo en cada corrida (xorshift con semilla de reloj).
        let mut x = seed ^ size as u64 | 1;
        let bytes: Vec<u8> = (0..size)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect();
        let predicted = kubo.add(bytes.clone(), true).await.expect("only-hash");
        let pinned = kubo.add(bytes, false).await.expect("add");
        assert_eq!(predicted, pinned, "CID distinto para {size} bytes");
        assert!(kubo.pin_ls("recursive").await.unwrap().contains(&pinned));
        kubo.pin_rm(&pinned).await.expect("pin rm");
        kubo.pin_rm(&pinned).await.expect("pin rm idempotente");
        assert!(!kubo.pin_ls("recursive").await.unwrap().contains(&pinned));
        println!("{size:>9} B → {pinned}");
    }
    let stat = kubo.repo_stat().await.unwrap();
    assert!(stat.storage_max > 0);
    assert!(kubo.free_space().await.unwrap() > 0);
}
