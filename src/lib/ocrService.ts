import type { OcrWorkerRequest, OcrWorkerResponse } from "../workers/ocr.worker";

export interface OcrProgressCallback {
  (progress: number, status: string, rawStatus: string): void;
}

export interface RunOcrOptions {
  onProgress?: OcrProgressCallback;
  signal?: AbortSignal;
  language?: string;
}

/**
 * Maps raw Tesseract status strings and progress values into clear, user-facing phase labels.
 * Examples: 'Initializing', 'Loading language model', 'Recognizing text', 'Finalizing'.
 */
export function formatOcrStatus(rawStatus: string, progress: number): string {
  const normalized = (rawStatus || "").toLowerCase().trim();

  if (
    normalized.includes("core") ||
    normalized.includes("init") ||
    normalized === "initializing"
  ) {
    return "Initializing";
  }

  if (
    normalized.includes("load") ||
    normalized.includes("traineddata") ||
    normalized.includes("language")
  ) {
    return "Loading language model";
  }

  if (normalized.includes("recogniz")) {
    if (progress >= 0.92) {
      return "Finalizing";
    }
    return "Recognizing text";
  }

  if (progress >= 0.98) {
    return "Finalizing";
  }

  if (!rawStatus) {
    return progress > 0 ? "Processing" : "Initializing";
  }

  // Capitalize sentence if not explicitly handled
  return rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1);
}

/**
 * Executes Tesseract OCR inside a dedicated Web Worker to prevent UI thread blocking.
 * Eliminates frame drops and UI freezes during high-resolution camera photo analysis.
 * Gracefully terminates worker resources upon completion, error, or abortion.
 */
export async function runOcrInWorker(
  file: File | Blob,
  onProgressOrOptions?: OcrProgressCallback | RunOcrOptions,
  maybeOptions?: RunOcrOptions
): Promise<string> {
  const options: RunOcrOptions =
    typeof onProgressOrOptions === "function"
      ? { ...maybeOptions, onProgress: onProgressOrOptions }
      : onProgressOrOptions || {};

  const { onProgress, signal, language = "eng" } = options;

  if (signal?.aborted) {
    throw new DOMException("OCR operation aborted", "AbortError");
  }

  const requestId = Math.random().toString(36).substring(2, 9);

  return new Promise((resolve, reject) => {
    let worker: Worker | null = null;
    let isSettled = false;

    const cleanup = () => {
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
      if (worker) {
        worker.terminate();
        worker = null;
      }
    };

    const handleAbort = () => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      reject(new DOMException("OCR operation aborted", "AbortError"));
    };

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    try {
      worker = new Worker(
        new URL("../workers/ocr.worker.ts", import.meta.url),
        { type: "module" }
      );
    } catch (err) {
      console.warn("[OCR] Failed to instantiate Web Worker, falling back to dynamic import:", err);
      // Fallback if workers are blocked in the runtime environment
      import("tesseract.js")
        .then(({ default: Tesseract }) => {
          if (signal?.aborted) {
            throw new DOMException("OCR operation aborted", "AbortError");
          }
          return Tesseract.recognize(file, language, {
            logger: (m) => {
              if (onProgress && typeof m.progress === "number") {
                const formatted = formatOcrStatus(m.status || "processing", m.progress);
                onProgress(m.progress, formatted, m.status || "processing");
              }
            },
          });
        })
        .then((res) => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          resolve(res.data.text || "");
        })
        .catch((fallbackErr) => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          reject(fallbackErr);
        });
      return;
    }

    worker.onmessage = (event: MessageEvent<OcrWorkerResponse>) => {
      const msg = event.data;
      if (!msg || msg.id !== requestId || isSettled) return;

      if (msg.type === "PROGRESS") {
        const formatted = formatOcrStatus(msg.status, msg.progress);
        onProgress?.(msg.progress, formatted, msg.status);
      } else if (msg.type === "SUCCESS") {
        isSettled = true;
        cleanup();
        resolve(msg.text);
      } else if (msg.type === "ERROR") {
        isSettled = true;
        cleanup();
        reject(new Error(msg.error));
      }
    };

    worker.onerror = (errEvent) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      reject(new Error(errEvent.message || "Unknown Web Worker OCR error"));
    };

    const request: OcrWorkerRequest = {
      id: requestId,
      file,
      language,
    };

    worker.postMessage(request);
  });
}
