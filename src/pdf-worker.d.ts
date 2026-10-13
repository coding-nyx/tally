// PDF.js ships this runtime worker entry without TypeScript declarations.
// The server imports it for its in-process handler registration side effect.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
