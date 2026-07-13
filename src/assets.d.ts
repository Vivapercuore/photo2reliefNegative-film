// Ambient declarations for static asset imports bundled by webpack (CRA).
// The project's tsconfig sets "types": ["react"], so CRA's own react-app-env
// typings aren't loaded — declare the asset modules we import explicitly.
declare module '*.png' {
  const url: string;
  export default url;
}
declare module '*.jpg' {
  const url: string;
  export default url;
}
declare module '*.svg' {
  const url: string;
  export default url;
}
