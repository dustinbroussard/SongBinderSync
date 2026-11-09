import Tesseract from "tesseract.js";

export interface OcrWorkerRequest {
  id: string;
  file: Blob | string;
  language?: string;
}

export interface OcrWorkerProgressMessage {
  type: "PROGRESS";
  id: string;
  status: string;
  progress: number;
}

export interface OcrWorkerSuccessMessage {
  type: "SUCCESS";
  id: string;
  text: string;
}

export interface OcrWorkerErrorMessage {
  type: "ERROR";
  id: string;
  error: string;
}

export type OcrWorkerResponse =
  | OcrWorkerProgressMessage
  | OcrWorkerSuccessMessage
  | OcrWorkerErrorMessage;

self.onmessage = async (e: MessageEvent<OcrWorkerRequest>) => {
  const { id, file, language = "eng" } = e.data;

  try {
    const result = await Tesseract.recognize(file, language, {
      logger: (m) => {
        if (m.status) {
          self.postMessage({
            type: "PROGRESS",
            id,
            status: m.status,
            progress: typeof m.progress === "number" ? m.progress : 0,
          } satisfies OcrWorkerProgressMessage);
        }
      },
    });

    self.postMessage({
      type: "SUCCESS",
      id,
      text: result.data.text || "",
    } satisfies OcrWorkerSuccessMessage);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    self.postMessage({
      type: "ERROR",
      id,
      error: errorMessage,
    } satisfies OcrWorkerErrorMessage);
  }
};
