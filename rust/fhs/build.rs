fn main() {
    println!("cargo:rerun-if-changed=proto/fhs-protocol.proto");
    prost_build::Config::new()
        .compile_protos(&["proto/fhs-protocol.proto"], &["proto"])
        .expect("canonical FHS protobuf must compile");
}
