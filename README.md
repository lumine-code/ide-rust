# ide-rust

Provide Rust language features with rust-analyzer.

Connects rust-analyzer to the editor's shared language-server client. The server is installed separately and runs once per project root.

## Features

- **Completion**: complete Rust names, fields, methods and imports with signature help.
- **Diagnostics**: show analysis errors and Cargo check findings.
- **Navigation**: provide definitions, references, document symbols, project symbols and call hierarchy.
- **Refactoring**: rename symbols and apply code actions across the project.
- **Formatting**: format Rust documents through rustfmt.
- **Inline information**: show inferred types, parameter hints, documentation and semantic highlighting.
- **Server management**: install verified official releases on Windows, macOS and Linux through Manage Servers.

## Installation

To install `ide-rust` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-rust`.

Install `ide` and `language-rust`. Use Manage Servers to install rust-analyzer, or install it through your Rust toolchain with `rustup component add rust-analyzer`. The package selects an explicit Server Path first, the managed installation next, and a working server on PATH last. A rustup proxy whose toolchain lacks rust-analyzer is skipped.

## Usage

Install a [Rust toolchain](https://rustup.rs/) and open the folder containing `Cargo.toml` or `rust-project.json`. The managed server includes the language server itself; project analysis uses your Rust toolchain. Add the components with `rustup component add rust-src rustfmt` for navigation into standard-library sources and document formatting.

The project's `rust-toolchain.toml` is respected unless you select a toolchain in the package settings. Leave analysis controls on Server Default to retain rust-analyzer's defaults. Build scripts and procedural macros follow those defaults and may execute code from the project as part of Cargo analysis.

Rust-analyzer supports call hierarchy. Type hierarchy is not advertised by the server. Its code lenses rely on client-specific Run, Debug and reference commands, so this adapter excludes them until the shared client can execute those commands.

## Services

- `ide`: consumed to register rust-analyzer and route its language features through the editor.
- `background-tips.provider`: provided to show a Rust setup tip on the empty workspace.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
