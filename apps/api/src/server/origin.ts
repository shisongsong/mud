import type { FastifyRequest } from "fastify";

export function isSameOriginRequest(
  request: FastifyRequest,
  expectedOrigin: string,
  allowHostOriginFallback: boolean,
): boolean {
  const originHeader = request.headers.origin;
  if (typeof originHeader !== "string" || originHeader === "null") return false;

  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.origin === expectedOrigin) return true;
  if (
    !allowHostOriginFallback ||
    (origin.protocol !== "http:" && origin.protocol !== "https:")
  ) {
    return false;
  }

  const host = request.headers.host;
  if (typeof host !== "string") return false;
  try {
    const requestUrl = new URL(`http://${host}`);
    return (
      requestUrl.username === "" &&
      requestUrl.password === "" &&
      requestUrl.pathname === "/" &&
      requestUrl.search === "" &&
      requestUrl.hash === "" &&
      origin.host === requestUrl.host
    );
  } catch {
    return false;
  }
}
