import { application, AppError, errorJson } from "./routes.mjs";

export { AppError } from "./routes.mjs";

export function createHandler(deps) {
  const handle = application(deps);
  return function handler(request) {
    return handle(request).catch((error) => {
      if (error instanceof AppError) return errorJson(error.code, error.status);
      console.error("unhandled_app_error", error instanceof Error ? error.message : String(error));
      return errorJson("service_unavailable", 503);
    });
  };
}