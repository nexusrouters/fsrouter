export default {
  id: "ibm-bob",
  priority: 80,
  alias: "ibm-bob",
  display: {
    name: "IBM Bob",
    icon: "psychology",
    color: "#0F62FE",
    textIcon: "IB",
    website: "https://bob.ibm.com",
    notice: {
      apiKeyUrl: "https://cloud.ibm.com/iam/apikeys",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.us-east.bob.ibm.com/inference/v1/chat/completions",
    forceStream: true,
  },
  models: [
    { id: "granite-8b-code-instruct", name: "Granite 8B Code Instruct" },
    { id: "granite-3-3-8b-instruct", name: "Granite 3.3 8B Instruct" },
    { id: "openai/gpt-oss-20b", name: "GPT OSS 20B" },
    { id: "rnj-1-test", name: "RNJ 1 Test" },
  ],
  serviceKinds: ["llm"],
};
