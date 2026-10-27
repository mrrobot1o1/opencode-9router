// Local-directory entrypoint. When a plugin is configured as a plain
// directory path, OpenCode resolves root-level `server` / `tui` files rather
// than the package exports map (those apply to npm-name installs).
export { default } from "./src/index"
