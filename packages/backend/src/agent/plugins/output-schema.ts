import Ajv2020 from "ajv/dist/2020.js";

const ajv = new Ajv2020({ strict: true, allErrors: false });

export function compileOutputSchema(json: string) {
  const schema: unknown = JSON.parse(json);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("output schema must be an object");
  }
  return ajv.compile(schema);
}
