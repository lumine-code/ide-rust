const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = `mod model;
pub use model::Point;

/// Adds two integer values.
pub fn add(left: i32, right: i32) -> i32 { left + right }

pub fn caller() -> i32 {
    let count = add(1, 2);
    let point = Point { x: count, y: 0 };
    point.sum()
}

pub fn wrong() -> i32 { "wrong" }
`;
const model = `pub struct Point {
    pub x: i32,
    pub y: i32,
}

impl Point {
    pub fn sum(&self) -> i32 {
        crate::add(self.x, self.y)
    }
}
`;

exports.createProject = () => {
  const temporary = process.env.IDE_RUST_TEST_TMP || os.tmpdir();
  fs.mkdirSync(temporary, { recursive: true });
  const rootPath = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, "ide-rust-live-")));
  fs.mkdirSync(path.join(rootPath, "src"));
  fs.writeFileSync(
    path.join(rootPath, "Cargo.toml"),
    '[package]\nname = "ide_rust_specs"\nversion = "0.1.0"\nedition = "2024"\n',
  );
  const filePath = path.join(rootPath, "src", "lib.rs");
  fs.writeFileSync(filePath, source);
  fs.writeFileSync(path.join(rootPath, "src", "model.rs"), model);
  return { rootPath, filePath, source, model };
};
exports.removeProject = (rootPath) =>
  fs.promises.rm(rootPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
