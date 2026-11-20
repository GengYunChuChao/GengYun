import { createDatabaseClient, createSiteContext, errorResponse } from "./_qoder/backend.mjs";
import { createStorageClient } from "./_qoder/storage.mjs";
import { createHandler, AppError } from "./handler.ts";
import { errorJson } from "./routes.mjs";

const handle = createHandler({
  db: createDatabaseClient(),
  storage: createStorageClient(),
});

Deno.serve(async (request) => {
  let context;
  try {
    context = createSiteContext(request, { forwardApplicationCredentials: true });
    return await handle(context.request);
  } catch (error) {
    if (error instanceof AppError) return errorJson(error.code, error.status);
    return errorResponse(error, context?.requestId);
  }
});