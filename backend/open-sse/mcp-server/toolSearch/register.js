import { toolSearchInput } from "../schemas/toolSearch.ts";
import { handleToolSearch } from "./handler.ts";
function registerToolSearchTool(server, withScopeEnforcement) {
  server.registerTool(
    "omniroute_tool_search",
    {
      description: "Search MCP tools by keyword; returns compact one-line TS signatures for token-efficient discovery.",
      inputSchema: toolSearchInput
    },
    withScopeEnforcement("omniroute_tool_search", (args) => {
      const parsed = toolSearchInput.parse(args ?? {});
      const result = handleToolSearch(parsed);
      return Promise.resolve({
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      });
    })
  );
}
export {
  registerToolSearchTool
};
