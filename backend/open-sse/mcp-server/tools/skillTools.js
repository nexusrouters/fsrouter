import { z } from "zod";
import { skillRegistry } from '../../../dist/lib/skills/registry.js';
import { skillExecutor } from '../../../dist/lib/skills/executor.js';
const SkillListSchema = z.object({
  apiKeyId: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional()
});
const SkillEnableSchema = z.object({
  apiKeyId: z.string(),
  skillId: z.string(),
  enabled: z.boolean()
});
const SkillExecuteSchema = z.object({
  apiKeyId: z.string(),
  skillName: z.string(),
  input: z.record(z.string(), z.unknown()),
  sessionId: z.string().optional()
});
const skillTools = {
  omniroute_skills_list: {
    name: "omniroute_skills_list",
    description: "List all registered skills with optional filtering by API key or name",
    scopes: ["read:skills"],
    inputSchema: SkillListSchema,
    handler: async (args) => {
      await skillRegistry.loadFromDatabase(args.apiKeyId);
      const skills = skillRegistry.list(args.apiKeyId);
      let filtered = skills;
      if (args.name) {
        filtered = filtered.filter((s) => s.name.includes(args.name));
      }
      if (args.enabled !== void 0) {
        filtered = filtered.filter((s) => s.enabled === args.enabled);
      }
      return {
        skills: filtered.map((s) => ({
          id: s.id,
          name: s.name,
          version: s.version,
          description: s.description,
          enabled: s.enabled,
          createdAt: s.createdAt.toISOString()
        })),
        count: filtered.length
      };
    }
  },
  omniroute_skills_enable: {
    name: "omniroute_skills_enable",
    description: "Enable or disable a specific skill by ID",
    scopes: ["write:skills"],
    inputSchema: SkillEnableSchema,
    handler: async (args) => {
      await skillRegistry.loadFromDatabase(args.apiKeyId);
      const skill = await skillRegistry.setEnabledById(args.skillId, args.apiKeyId, args.enabled);
      if (!skill) {
        throw new Error(`Skill not found: ${args.skillId}`);
      }
      return { success: true, skillId: args.skillId, enabled: args.enabled };
    }
  },
  omniroute_skills_execute: {
    name: "omniroute_skills_execute",
    description: "Execute a skill with provided input and return the result",
    scopes: ["execute:skills"],
    inputSchema: SkillExecuteSchema,
    handler: async (args) => {
      const execution = await skillExecutor.execute(args.skillName, args.input, {
        apiKeyId: args.apiKeyId,
        sessionId: args.sessionId
      });
      return {
        id: execution.id,
        skillId: execution.skillId,
        status: execution.status,
        output: execution.output,
        error: execution.errorMessage,
        duration: execution.durationMs,
        createdAt: execution.createdAt.toISOString()
      };
    }
  },
  omniroute_skills_executions: {
    name: "omniroute_skills_executions",
    description: "List recent skill execution history",
    scopes: ["read:skills"],
    inputSchema: z.object({
      apiKeyId: z.string().optional(),
      limit: z.number().int().positive().max(100).optional()
    }),
    handler: async (args) => {
      const executions = skillExecutor.listExecutions(args.apiKeyId, args.limit || 50);
      return {
        executions: executions.map((e) => ({
          id: e.id,
          skillId: e.skillId,
          status: e.status,
          duration: e.durationMs,
          error: e.errorMessage,
          createdAt: e.createdAt.toISOString()
        })),
        count: executions.length
      };
    }
  }
};
export {
  SkillEnableSchema,
  SkillExecuteSchema,
  SkillListSchema,
  skillTools
};
