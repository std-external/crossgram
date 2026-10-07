{
  description = "Crossgram voice relay development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {nixpkgs, ...}: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {inherit system;};

    sourcePins = {
      tdesktop = {
        url = "https://github.com/telegramdesktop/tdesktop/archive/f238e46ff988ec502290f6e691bd67c11cf5c75a.tar.gz";
        hash = "sha256-QSKImOFeefC5frgs1AtXpFoSvPC95DOPJ5485tDx67c=";
      };
      tdesktop-cmake-helpers = {
        url = "https://github.com/desktop-app/cmake_helpers/archive/80cd031dc4c81805b8bb118e8250356afaad6614.tar.gz";
        hash = "sha256-8vVignSYF4N1pFHdNEMFu2OxyiBHFLkr80IcYgU1nJI=";
      };
      tgcalls = {
        url = "https://github.com/TelegramMessenger/tgcalls/archive/2faee3b5524f54d56c91c2058c00e11c656a74b3.tar.gz";
        rev = "2faee3b5524f54d56c91c2058c00e11c656a74b3";
        hash = "sha256-+2z28JK8uYbr532QOFsiSBIc4JhRWBvIzjgkGiSf/Cs=";
      };
      tg-owt = {
        url = "https://github.com/desktop-app/tg_owt.git";
        rev = "5c5c71258777d0196dbb3a09cc37d2f56ead28ab";
        hash = "sha256-4CAo3lbj2acj9UsNjUDnyF+tjUrah53DylKuFLewQwA=";
      };
    };

    fetchPinnedSource = pin:
      pkgs.fetchzip {
        inherit (pin) url hash;
        stripRoot = true;
      };

    tdesktopSource = fetchPinnedSource sourcePins.tdesktop;
    tdesktopHelpersSource = fetchPinnedSource sourcePins.tdesktop-cmake-helpers;
    tgcallsSource = fetchPinnedSource sourcePins.tgcalls;
    tgOwtSource =
      (builtins.fetchTree {
        type = "git";
        inherit (sourcePins.tg-owt) url rev;
        narHash = sourcePins.tg-owt.hash;
        submodules = true;
      }).outPath;

    tdesktopHelpers = pkgs.runCommand "tdesktop-tgcalls-cmake-helpers" {} ''
      mkdir -p "$out"
      cp ${tdesktopHelpersSource}/init_target.cmake "$out/"
      cp ${tdesktopHelpersSource}/nice_target_sources.cmake "$out/"
      cp ${tdesktopHelpersSource}/target_compile_options_if_exists.cmake "$out/"
      cp ${tdesktopSource}/Telegram/cmake/lib_tgcalls.cmake "$out/"
    '';

    tgOwtInputs = with pkgs; [
      crc32c
      ffmpeg
      libjpeg_turbo
      libvpx
      openh264
      openssl
      opus
      srtp
      zlib
    ];

    tgOwt = pkgs.stdenv.mkDerivation {
      pname = "tg-owt";
      version = sourcePins.tg-owt.rev;
      src = tgOwtSource;
      strictDeps = true;
      nativeBuildInputs = with pkgs; [cmake ninja pkg-config python3];
      buildInputs = tgOwtInputs;
      propagatedBuildInputs = tgOwtInputs;
      cmakeFlags = [
        "-DBUILD_SHARED_LIBS=OFF"
        "-DCMAKE_DISABLE_FIND_PACKAGE_absl=ON"
        "-DTG_OWT_USE_PIPEWIRE=OFF"
        "-DTG_OWT_USE_X11=OFF"
        "-DTG_OWT_BUILD_AUDIO_BACKENDS=OFF"
      ];
      SOURCE_DATE_EPOCH = "1";
      ZERO_AR_DATE = "1";
    };

    tgcallsStaticInputs = with pkgs; [
      tgOwt
      ffmpeg
      openssl
      rnnoise
      zlib
    ];

    tgcallsArtifact = pkgs.stdenv.mkDerivation {
      pname = "tgcalls-artifact";
      version = sourcePins.tgcalls.rev;
      dontUnpack = true;
      dontConfigure = true;
      strictDeps = true;
      nativeBuildInputs = with pkgs; [cmake ninja pkg-config];
      buildInputs = tgcallsStaticInputs;
      SOURCE_DATE_EPOCH = "1";
      ZERO_AR_DATE = "1";
      buildPhase = ''
        runHook preBuild
        mkdir source
        cp -R ${tgcallsSource} source/tgcalls
        chmod -R u+w source
        install -Dm644 ${./third_party/tgcalls/CMakeLists.txt} source/CMakeLists.txt
        install -Dm644 ${./third_party/tgcalls/no_call.cpp} source/no_call.cpp
        substituteInPlace source/CMakeLists.txt \
          --replace-fail '@tgcallsSource@' "$PWD/source" \
          --replace-fail '@tdesktopHelpers@' '${tdesktopHelpers}'
        patch -d source/tgcalls -p1 < ${./third_party/tgcalls/patches/fake-adm-stop-recording.patch}
        patch -d source/tgcalls -p1 < ${./third_party/tgcalls/patches/synchronous-teardown.patch}
        cmake -S source -B build -G Ninja \
          -DCMAKE_BUILD_TYPE=Release \
          -DCMAKE_PREFIX_PATH=${tgOwt}
        cmake --build build --target lib_tgcalls tgcalls_no_call_probe -j"$NIX_BUILD_CORES"
        runHook postBuild
      '';
      doCheck = true;
      checkPhase = ''
        runHook preCheck
        nm -C --defined-only build/tgcalls_no_call_probe \
          | grep -F 'tgcalls::isGzip(std::vector<unsigned char, std::allocator<unsigned char> > const&)' >/dev/null
        ./build/tgcalls_no_call_probe
        runHook postCheck
      '';
      installPhase = ''
        runHook preInstall
        install -Dm644 build/liblib_tgcalls.a "$out/lib/liblib_tgcalls.a"
        mkdir -p "$out/include"
        cp -R source/tgcalls/tgcalls "$out/include/tgcalls"
        runHook postInstall
      '';
    };

    tgcallsShim = pkgs.stdenv.mkDerivation {
      pname = "crossgram-tgcalls-shim";
      version = sourcePins.tgcalls.rev;
      src = builtins.path {
        path = ./native/tgcalls-shim;
        name = "crossgram-tgcalls-shim-source";
      };
      strictDeps = true;
      nativeBuildInputs = with pkgs; [cmake ninja pkg-config];
      buildInputs = tgcallsStaticInputs ++ [tgcallsArtifact];
      propagatedBuildInputs = tgcallsStaticInputs ++ [tgcallsArtifact];
      cmakeFlags = [
        "-DCROSSGRAM_TGCALLS_SHIM_BUILD_TESTS=ON"
        "-DCROSSGRAM_TGCALLS_SHIM_ENABLE_ARTIFACT=ON"
        "-DCROSSGRAM_TGCALLS_ARTIFACT_ROOT=${tgcallsArtifact}"
      ];
      SOURCE_DATE_EPOCH = "1";
      doCheck = true;
      checkPhase = ''
        runHook preCheck
        ctest --output-on-failure
        runHook postCheck
      '';
      installPhase = ''
        runHook preInstall
        cmake --install .
        runHook postInstall
      '';
    };

    tgcallsShimShared = tgcallsShim.overrideAttrs (old: {
      pname = "crossgram-tgcalls-shim-shared";
      cmakeFlags = old.cmakeFlags ++ ["-DCROSSGRAM_TGCALLS_SHIM_BUILD_SHARED=ON"];
    });

    voiceWorker = pkgs.rustPlatform.buildRustPackage {
      pname = "crossgram-voice-worker";
      version = "0.1.0";
      src = builtins.path {
        path = ./packages/voice-worker;
        name = "crossgram-voice-worker-source";
      };
      cargoLock.lockFile = ./packages/voice-worker/Cargo.lock;
      strictDeps = true;
      nativeBuildInputs = [pkgs.pkg-config];
      buildInputs = [tgcallsShimShared];
      CROSSGRAM_TGCALLS_SHIM_INCLUDE_DIR = "${tgcallsShimShared}/include";
      CROSSGRAM_TGCALLS_SHIM_LIB_DIR = "${tgcallsShimShared}/lib";
      cargoBuildFlags = ["--features" "native-tgcalls-shim"];
      cargoTestFlags = ["--features" "native-tgcalls-shim"];
    };

    voiceWorkerLauncher = pkgs.writeShellScriptBin "crossgram-voice-worker-launcher" ''
      if test "$#" -ne 0; then
        exec ${voiceWorker}/bin/crossgram-voice-worker "$@"
      fi
      if test "''${CROSSGRAM_VOICE_WORKER_LAUNCHER_REEXEC:-}" != 1; then
        exec ${pkgs.coreutils}/bin/env \
          --default-signal=HUP --default-signal=INT --default-signal=TERM \
          CROSSGRAM_VOICE_WORKER_LAUNCHER_REEXEC=1 "$0"
      fi

      if test -n "''${CROSSGRAM_VOICE_WORKER_SOCKET:-}"; then
        socket="$CROSSGRAM_VOICE_WORKER_SOCKET"
      elif test -n "''${XDG_RUNTIME_DIR:-}"; then
        socket="$XDG_RUNTIME_DIR/crossgram/voice-worker.sock"
      else
        socket="''${TMPDIR:-/tmp}/crossgram-voice-worker-''${UID}/worker.sock"
      fi
      socket_parent="$(${pkgs.coreutils}/bin/dirname -- "$socket")"
      ${pkgs.coreutils}/bin/mkdir -p -- "$socket_parent"
      ${pkgs.coreutils}/bin/chmod 700 -- "$socket_parent"

      # This check is deliberately repeated immediately before the worker starts.
      # Publication below is still atomic, so a later creator wins without replacement.
      if test -e "$socket" || test -L "$socket"; then
        ${pkgs.coreutils}/bin/printf 'refusing to replace an existing Unix socket path: %s\\n' "$socket" >&2
        exit 1
      fi

      staging_dir="$(${pkgs.coreutils}/bin/mktemp -d "$socket_parent/.voice-worker.XXXXXX")"
      ${pkgs.coreutils}/bin/chmod 700 -- "$staging_dir"
      staging_socket="$staging_dir/worker.sock"
      worker=""
      staging_socket_identity=""
      published_socket_identity=""
      cleanup() {
        status=$?
        trap - EXIT INT TERM HUP
        if test -n "$published_socket_identity" || {
          test -n "$staging_socket_identity" &&
            ! test -e "$staging_socket" &&
            ! test -L "$staging_socket"
        }; then
          current_identity="$(${pkgs.coreutils}/bin/stat -c '%d:%i' -- "$socket" 2>/dev/null || true)"
          if test "$current_identity" = "$staging_socket_identity"; then
            ${pkgs.coreutils}/bin/rm -f -- "$socket"
          fi
        fi
        if test -n "$staging_socket_identity"; then
          current_identity="$(${pkgs.coreutils}/bin/stat -c '%d:%i' -- "$staging_socket" 2>/dev/null || true)"
          if test "$current_identity" = "$staging_socket_identity"; then
            ${pkgs.coreutils}/bin/rm -f -- "$staging_socket"
          fi
        fi
        ${pkgs.coreutils}/bin/rmdir -- "$staging_dir" 2>/dev/null || true
        exit "$status"
      }
      forward_signal() {
        signal="$1"
        signal_status="$2"
        if test -n "$worker" && kill -0 "$worker" 2>/dev/null; then
          kill "-$signal" "$worker" || true
        fi
        if test -n "$worker"; then
          wait "$worker" || true
        fi
        exit "$signal_status"
      }
      trap cleanup EXIT
      trap 'forward_signal HUP 129' HUP
      trap 'forward_signal INT 130' INT
      trap 'forward_signal TERM 143' TERM

      ${pkgs.coreutils}/bin/env \
        --default-signal=HUP --default-signal=INT --default-signal=TERM \
        ${voiceWorker}/bin/crossgram-voice-worker --unix "$staging_socket" &
      worker="$!"
      while kill -0 "$worker" 2>/dev/null; do
        if test -S "$staging_socket"; then
          staging_socket_identity="$(${pkgs.coreutils}/bin/stat -c '%d:%i' -- "$staging_socket")"
          break
        fi
      done
      if test -z "$staging_socket_identity"; then
        wait "$worker"
        exit "$?"
      fi

      if ${voiceWorker}/bin/crossgram-voice-worker \
        --publish-unix-noreplace "$staging_socket" "$socket"; then
        published_socket_identity="$staging_socket_identity"
      else
        publish_status=$?
        if kill -0 "$worker" 2>/dev/null; then
          kill -TERM "$worker" || true
        fi
        wait "$worker" || true
        exit "$publish_status"
      fi
      current_identity="$(${pkgs.coreutils}/bin/stat -c '%d:%i' -- "$socket" 2>/dev/null || true)"
      if test "$current_identity" != "$staging_socket_identity"; then
        ${pkgs.coreutils}/bin/printf 'published Unix socket identity changed unexpectedly: %s\\n' "$socket" >&2
        if kill -0 "$worker" 2>/dev/null; then
          kill -TERM "$worker" || true
        fi
        wait "$worker" || true
        exit 1
      fi
      wait "$worker"
    '';

    corepack = pkgs.writeShellScriptBin "corepack" ''
      exec ${pkgs.corepack}/bin/corepack "$@"
    '';

    yarn = pkgs.writeShellScriptBin "yarn" ''
      exec ${pkgs.corepack}/bin/corepack yarn "$@"
    '';

    buildTools = with pkgs; [
      autoconf
      automake
      binutils
      cargo
      clippy
      cmake
      gcc
      git
      gnumake
      libtool
      m4
      meson
      nasm
      ninja
      nodejs_24
      patchelf
      perl
      pkg-config
      pnpm
      python312
      rustc
      rustfmt
      yasm
    ];

    voiceLibraries = with pkgs; [
      abseil-cpp
      alsa-lib
      dav1d
      dbus
      ffmpeg
      glib
      gobject-introspection
      libdrm
      libevent
      libffi
      libjpeg_turbo
      libunwind
      libvpx
      libxkbcommon
      mesa
      openh264
      openssl
      opus
      pipewire
      protobuf
      pulseaudio
      systemd
      wayland
      wayland-protocols
      zlib
      libx11
      libxcomposite
      libxdamage
      libxext
      libxfixes
      libxrandr
      libxrender
      libxtst
    ];
  in {
    packages.${system} = {
      default = voiceWorker;
      voice-worker = voiceWorker;
      tgcalls-artifact = tgcallsArtifact;
    };

    apps.${system}.voice-worker = {
      type = "app";
      program = "${voiceWorkerLauncher}/bin/crossgram-voice-worker-launcher";
      meta.description = "Launch the Crossgram voice worker on its default Unix socket";
    };

    devShells.${system}.default = pkgs.mkShell {
      packages = [corepack yarn] ++ buildTools ++ voiceLibraries;

      LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath voiceLibraries;

      shellHook = ''
        export CARGO_TARGET_DIR="''${CARGO_TARGET_DIR:-$PWD/packages/voice-worker/target}"
        echo "Crossgram voice environment: Node $(node --version), Rust $(rustc --version), CMake $(cmake --version | head -n1), Meson $(meson --version)"
      '';
    };

    formatter.${system} = pkgs.alejandra;
  };
}
