// src/constants/agentConstants.js

export const MODEL_PROVIDERS_LITELLM = [
    {
        id: "openai",
        name: "OpenAI",
        apiBase: "https://api.openai.com/v1",
        requiresApiKeyInEnv: "OPENAI_API_KEY",
        allowsCustomBase: true, // OpenAI allows specifying a different base URL (e.g., for proxies)
        allowsCustomKey: true,
        liteLlmModelPrefix: "openai",
        models: [
            { id: "gpt-4o", name: "GPT-4o (Omni)" },
            { id: "o4-mini-2025-04-16", name: "o4 Mini" },
            { id: "o3-mini-2025-01-31", name: "o3 Mini" },
        ]
    },
    {
        id: "watsonx",
        name: "IBM WatsonX (Coming Soon)",
        apiBase: null, // User must provide WATSONX_URL
        requiresApiKeyInEnv: "WATSONX_APIKEY", // or WATSONX_TOKEN
        allowsCustomBase: true, // WatsonX URL is the base
        allowsCustomKey: true,
        liteLlmModelPrefix: "watsonx", // e.g. watsonx/google/flan-t5-xxl
        models: [
            
        ],
        customInstruction: "For IBM WatsonX, ensure WATSONX_URL and WATSONX_APIKEY (or WATSONX_TOKEN) are set in the backend or passed. Model String is the WatsonX model ID (e.g., google/flan-t5-xxl). Also requires WATSONX_PROJECT_ID."
    },
    {
        id: "deepinfra",
        name: "DeepInfra",
        apiBase: "https://api.deepinfra.com/v1/openai",
        requiresApiKeyInEnv: "DEEPINFRA_API_KEY",
        allowsCustomBase: false, // DeepInfra has a fixed base for OpenAI compatibility
        allowsCustomKey: true,
        liteLlmModelPrefix: "deepinfra", // e.g. deepinfra/meta-llama/Llama-2-70b-chat-hf
        models: [
            // Model IDs are provider-org/model-name
            { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B Instruct Turbo (DeepInfra)" },
            { id: "meta-llama/Meta-Llama-3-70B-Instruct", name: "Llama 3 70B Instruct (DeepInfra)" },
            { id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", name: "Llama 4 Maverick 17Bx128E Instruct FP8"},
            { id: "meta-llama/Llama-4-Scout-17B-16E-Instruct", name: "Llama 4 Scout 17Bx16E Instruct FP8"},
            { id: "mistralai/Mistral-7B-Instruct-v0.1", name: "Mistral 7B Instruct (DeepInfra)" },
        ],
        customInstruction: "For DeepInfra, Model String is the full model path (e.g., meta-llama/Meta-Llama-3-8B-Instruct)."
    },
    
];

// Default provider and model
export const DEFAULT_LITELLM_PROVIDER_ID = "openai"; // OpenAI is a common default
export const DEFAULT_LITELLM_MODEL_STRING = "openai/gpt-4o"; // Default to GPT-4o for OpenAI
const defaultProvider = MODEL_PROVIDERS_LITELLM.find(p => p.id === DEFAULT_LITELLM_PROVIDER_ID);
export const DEFAULT_LITELLM_BASE_MODEL_ID = defaultProvider?.models[0]?.id || "gpt-3.5-turbo"; // Default to first model of default provider

export const AGENT_TYPES = ["Agent", "SequentialAgent", "ParallelAgent", "LoopAgent"];

export const getLiteLLMProviderConfig = (providerId) => {
    return MODEL_PROVIDERS_LITELLM.find(p => p.id === providerId);
};  
