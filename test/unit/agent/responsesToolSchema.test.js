"use strict";
const { toolsToResponsesTools } = require("../../../src/agents/providers/transports/responsesProtocol");
const { CONTROLLER_TOOL_SCHEMAS } = require("../../../src/tools/controllerSchemas");
test("Responses explicitly keeps optional delegation fields optional and honors deliberately strict tools", () => {
  const schema = CONTROLLER_TOOL_SCHEMAS.delegate_task.input_schema;
  const converted = toolsToResponsesTools([{ type: "function", function: { name: "delegate_task", parameters: schema } }, { type: "function", function: { name: "strict_tool", strict: true, parameters: { type: "object" } } }]);
  expect(converted[0].strict).toBe(false);
  expect(converted[1].strict).toBe(true);
  expect(converted[0].parameters.required).not.toContain("target");
  expect(converted[0].parameters).toEqual(schema);
});
