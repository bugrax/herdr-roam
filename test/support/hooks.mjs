// Lets tests import mod files that import "herdr": resolves it to a stub.
export async function resolve(specifier, context, next) {
  if (specifier === "herdr") return { url: new URL("./herdr.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
