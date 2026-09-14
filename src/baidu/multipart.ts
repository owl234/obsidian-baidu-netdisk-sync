/**
 * Binary multipart/form-data builder for pure TypeScript / Obsidian requestUrl.
 * Zero external dependencies.
 */

export function buildMultipartFormData(
  fileBuffer: ArrayBuffer,
  fieldName = "file",
  fileName = "blob"
): { body: ArrayBuffer; contentType: string } {
  const boundary = "----BaiduSyncBoundary" + Math.random().toString(36).substring(2) + Date.now().toString(36);
  const encoder = new TextEncoder();

  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  const headBytes = encoder.encode(head);
  const tailBytes = encoder.encode(tail);
  const fileBytes = new Uint8Array(fileBuffer);

  const totalLength = headBytes.length + fileBytes.length + tailBytes.length;
  const result = new Uint8Array(totalLength);

  let offset = 0;
  result.set(headBytes, offset);
  offset += headBytes.length;

  result.set(fileBytes, offset);
  offset += fileBytes.length;

  result.set(tailBytes, offset);

  return {
    body: result.buffer,
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}
