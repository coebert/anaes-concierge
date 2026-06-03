// Top-level enum is referenced before it's declared. Codemod should move it up.
export const DEFAULT_LEVEL: Level = Level.Info;

export enum Level {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
}
