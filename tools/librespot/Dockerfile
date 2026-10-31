# Builds the librespot binary the Spotify app downloads:
#   docker build --output out tools/librespot
FROM rust:1.99-bookworm AS build
RUN dpkg --add-architecture arm64 && apt-get update && apt-get install -y --no-install-recommends \
    crossbuild-essential-arm64 libasound2-dev:arm64 libpulse-dev:arm64 cmake clang pkg-config \
    && rustup target add aarch64-unknown-linux-gnu
COPY patches /patches
RUN git clone https://github.com/librespot-org/librespot /src && cd /src \
    && git checkout ea813143c9a2bbfc8bd032d759d5b0acc5f40f3c \
    && git apply /patches/*.patch
WORKDIR /src
ENV PKG_CONFIG_ALLOW_CROSS=1 \
    PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
RUN cargo build --release --locked --target aarch64-unknown-linux-gnu --no-default-features \
    --features "alsa-backend pulseaudio-backend with-avahi rustls-tls-native-roots"

FROM scratch
COPY --from=build /src/target/aarch64-unknown-linux-gnu/release/librespot /librespot-tvbox-aarch64
