# functions/common/adk_helpers.py
import re
import os
import importlib
import traceback
import asyncio # Import asyncio
from .core import logger
from google.adk.agents import Agent, SequentialAgent, LoopAgent, ParallelAgent # LlmAgent is aliased as Agent
from google.adk.tools.agent_tool import AgentTool
from google.adk.models.lite_llm import LiteLlm
from google.genai import types as genai_types # For GenerateContentConfig
# Updated import for MCPToolset and its params
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset

from google.adk.tools.mcp_tool.mcp_session_manager import (
    StreamableHTTPConnectionParams,
    SseServerParams,
)

# SseServerParams was already imported from mcp_tool.mcp_toolset,
# StreamableHTTPConnectionParams is also available there.

# This mapping helps the backend determine LiteLLM prefixes and expected API key env vars.
# It's a simplified version of what was in PYTHON_AGENT_CONSTANTS before,
# as the frontend now sends more structured data.
BACKEND_LITELLM_PROVIDER_CONFIG = {
    "openai": {"prefix": "openai", "apiKeyEnv": "OPENAI_API_KEY"},
    "openai_compatible": {"prefix": "openai", "apiKeyEnv": None}, # User provides key/base
    "google_ai_studio": {"prefix": "gemini", "apiKeyEnv": "GEMINI_API_KEY"},
    "anthropic": {"prefix": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY"},
    "bedrock": {"prefix": "bedrock", "apiKeyEnv": "AWS_ACCESS_KEY_ID"}, # Needs others like SECRET, REGION
    "meta_llama": {"prefix": "meta_llama", "apiKeyEnv": "LLAMA_API_KEY"},
    "mistral": {"prefix": "mistral", "apiKeyEnv": "MISTRAL_API_KEY"},
    "watsonx": {"prefix": "watsonx", "apiKeyEnv": "WATSONX_APIKEY"}, # Needs WATSONX_URL, WATSONX_PROJECT_ID
    "deepseek": {"prefix": "deepseek", "apiKeyEnv": "DEEPSEEK_API_KEY"},
    "deepinfra": {"prefix": "deepinfra", "apiKeyEnv": "DEEPINFRA_API_KEY"},
    "replicate": {"prefix": "replicate", "apiKeyEnv": "REPLICATE_API_KEY"},
    "together_ai": {"prefix": "together_ai", "apiKeyEnv": "TOGETHER_AI_API_KEY"},
    "azure": {"prefix": "azure", "apiKeyEnv": "AZURE_API_KEY"}, # Needs AZURE_API_BASE, AZURE_API_VERSION
    "custom": {"prefix": None, "apiKeyEnv": None} # No prefix, user provides full string
}


async def _prepare_agent_kwargs_from_config(agent_config, adk_agent_name: str, context_for_log: str = ""): # Made async
    logger.info(f"Preparing kwargs for ADK agent '{adk_agent_name}' {context_for_log}. Original config name: '{agent_config.get('name', 'N/A')}'")

    instantiated_tools = []
    mcp_tools_by_server = {} # {'server_url_1': ['tool_name_A', 'tool_name_B'], ...}
    user_defined_tools_config = agent_config.get("tools", [])
    logger.info(f"user_defined_tools_config for agent '{adk_agent_name}': {user_defined_tools_config}")
    for tc_idx, tc in enumerate(user_defined_tools_config):
        tool_type = tc.get('type')
        if tool_type is None and tc.get('module_path') and tc.get('class_name'):
            # If type is missing but module_path and class_name are present, assume it's a gofannon tool
            tool_type = 'gofannon'
            tc['type'] = 'gofannon'  # Set the type for downstream processing
            logger.info(f"Auto-detected tool type 'gofannon' for tool with module_path: {tc.get('module_path')}")

        if tool_type == 'mcp':
            server_url = tc.get('mcpServerUrl') # This should be the full endpoint URL
            tool_name_on_server = tc.get('mcpToolName') # Original name on MCP server
            if server_url and tool_name_on_server:
                if server_url not in mcp_tools_by_server:
                    mcp_tools_by_server[server_url] = []
                mcp_tools_by_server[server_url].append(tool_name_on_server)
                logger.info(f"Queued MCP tool '{tool_name_on_server}' from server '{server_url}' for agent '{adk_agent_name}'.")
            else:
                logger.warn(f"Skipping MCP tool for agent '{adk_agent_name}' due to missing mcpServerUrl or mcpToolName: {tc}")
        elif tool_type == 'gofannon' or tool_type == 'custom_repo':
            try:
                tool_instance = instantiate_tool(tc)
                instantiated_tools.append(tool_instance)
                logger.info(f"Successfully instantiated tool '{tc.get('id', f'index_{tc_idx}')}' (type: {tool_type}) for agent '{adk_agent_name}'.")
            except ValueError as e:
                logger.warn(f"Skipping tool for agent '{adk_agent_name}' due to error: {e} (Tool config: {tc.get('id', f'index_{tc_idx}')}, Type: {tool_type})")
        else:
            logger.warn(f"Unknown or unhandled tool type '{tool_type}' for agent '{adk_agent_name}'. Tool config: {tc}")


            # After iterating all tool_configs, create MCPToolset instances using MCPToolset.from_server
    for server_url, tool_names_filter in mcp_tools_by_server.items():
        try:
            connection_params = None
            conn_type_log = ""
            # The server_url from UI should be the full endpoint URL.
            # e.g., http://localhost:8001/sse or http://localhost:8000/mcp
            if server_url.endswith("/sse"): # Heuristic based on common SSE endpoint naming
                connection_params = SseServerParams(url=server_url)
                conn_type_log = "SSE"
            else: # Default to StreamableHTTP for other URLs
                # Ensure server_url is the correct endpoint for StreamableHTTP (e.g., ends with /mcp)
                connection_params = StreamableHTTPConnectionParams(url=server_url)
                conn_type_log = "StreamableHTTP"

            unique_tool_filter = list(set(tool_names_filter))
            logger.info(f"Attempting MCPToolset.from_server for '{server_url}' ({conn_type_log}) with tool filter: {unique_tool_filter} for agent '{adk_agent_name}'.")

            # MCPToolset.from_server is an async class method.
            # It returns a tuple: (MCPToolset instance, AsyncExitStack instance)
            toolset = MCPToolset(
                    connection_params=connection_params,
                    tool_filter=unique_tool_filter,
                    errlog= None # Otherwise has issues with pickling, hack should be directed to firebase logger.
            )
            logger.info(f"toolset: {toolset}")
            mcp_toolset_instance = toolset


            # The ADK agent/runner is expected to manage the lifecycle of the mcp_toolset_instance,
            # including any resources associated with the _exit_stack.
            # We append the toolset instance directly.
            instantiated_tools.append(mcp_toolset_instance)
            logger.info(f"Successfully created and added MCPToolset (via from_server) for server '{server_url}' to agent '{adk_agent_name}' with {len(unique_tool_filter)} tools filtered.")
        except Exception as e_mcp_toolset:
            logger.error(f"Failed to create MCPToolset via from_server for server '{server_url}' for agent '{adk_agent_name}': {type(e_mcp_toolset).__name__} - {e_mcp_toolset}")
            # Optionally, re-raise or add a placeholder error tool if critical


    selected_provider_id = agent_config.get("selectedProviderId")
    base_model_name_from_config = agent_config.get("litellm_model_string")
    user_api_base_override = agent_config.get("litellm_api_base")
    user_api_key_override = agent_config.get("litellm_api_key")

    if not selected_provider_id:
        logger.warn(f"Missing 'selectedProviderId' in agent config '{agent_config.get('name', 'N/A')}' {context_for_log}. This is unexpected. Attempting fallback inference.")
        if base_model_name_from_config:
            if "gpt" in base_model_name_from_config.lower(): selected_provider_id = "openai"
            elif "gemini" in base_model_name_from_config.lower(): selected_provider_id = "google_ai_studio"
            elif "claude" in base_model_name_from_config.lower(): selected_provider_id = "anthropic"
        if not selected_provider_id :
            selected_provider_id = "custom"
            logger.warn(f"Could not infer provider. Defaulting to '{selected_provider_id}'. Model string '{base_model_name_from_config}' will be used as is.")

    if not base_model_name_from_config and selected_provider_id != "custom" and selected_provider_id != "openai_compatible":
        logger.warn(f"Missing 'litellm_model_string' for provider '{selected_provider_id}'. This may lead to errors.")

    provider_backend_config = BACKEND_LITELLM_PROVIDER_CONFIG.get(selected_provider_id)
    if not provider_backend_config:
        logger.error(f"Invalid 'selectedProviderId': {selected_provider_id}. Cannot determine LiteLLM prefix or API key for agent '{adk_agent_name}'.")
        raise ValueError(f"Invalid provider ID: {selected_provider_id}")

    final_model_str_for_litellm = base_model_name_from_config
    if provider_backend_config["prefix"]:
        if selected_provider_id == "azure":
            if not base_model_name_from_config.startswith("azure/"): # LiteLLM expects "azure/your-deployment-name"
                final_model_str_for_litellm = f"azure/{base_model_name_from_config}"
        elif not base_model_name_from_config.startswith(provider_backend_config["prefix"] + "/"):
            final_model_str_for_litellm = f"{provider_backend_config['prefix']}/{base_model_name_from_config}"

    final_api_base = user_api_base_override
    final_api_key = user_api_key_override
    if not final_api_key and provider_backend_config["apiKeyEnv"]:
        final_api_key = os.getenv(provider_backend_config["apiKeyEnv"])
        if not final_api_key and provider_backend_config["apiKeyEnv"] not in ["AWS_ACCESS_KEY_ID", "WATSONX_APIKEY"]: # These have complex auth beyond just one key
            logger.warn(f"API key env var '{provider_backend_config['apiKeyEnv']}' for provider '{selected_provider_id}' not set, and no override provided. LiteLLM may fail if key is required by the provider or its default configuration.")

    if selected_provider_id == "azure":
        if not os.getenv("AZURE_API_BASE") and not final_api_base: # AZURE_API_BASE is critical for Azure
            logger.error("Azure provider selected, but AZURE_API_BASE is not set in environment and no API Base override provided. LiteLLM will likely fail.")
        if not os.getenv("AZURE_API_VERSION"): # AZURE_API_VERSION is also usually required
            logger.warn("Azure provider selected, but AZURE_API_VERSION is not set in environment. LiteLLM may require it.")

    if selected_provider_id == "watsonx":
        if not os.getenv("WATSONX_URL") and not final_api_base:
            logger.error("WatsonX provider: WATSONX_URL env var not set and not overridden by user. LiteLLM will likely fail.")
        if not os.getenv("WATSONX_PROJECT_ID") and not agent_config.get("project_id"): # project_id can be in config or env
            logger.warn("WatsonX provider: WATSONX_PROJECT_ID env var not set and no project_id in agent_config. LiteLLM may require it.")


    logger.info(f"Configuring LiteLlm for agent '{adk_agent_name}' (Provider: {selected_provider_id}): "
                f"Model='{final_model_str_for_litellm}', API Base='{final_api_base or 'Default/Env'}', KeyIsSet={(not not final_api_key) or (selected_provider_id in ['bedrock', 'watsonx'])}")


    model_constructor_kwargs = {"model": final_model_str_for_litellm}
    if final_api_base:
        model_constructor_kwargs["api_base"] = final_api_base
    if final_api_key:
        model_constructor_kwargs["api_key"] = final_api_key

        # Specific handling for WatsonX project_id and space_id
    if selected_provider_id == "watsonx":
        project_id_for_watsonx = agent_config.get("project_id") or os.getenv("WATSONX_PROJECT_ID")
        if project_id_for_watsonx:
            model_constructor_kwargs["project_id"] = project_id_for_watsonx
        else:
            # project_id is often required by LiteLLM for watsonx
            logger.warn(f"WatsonX project_id not found for agent {adk_agent_name}. This might be required by LiteLLM.")
            # space_id for watsonx deployments
        if base_model_name_from_config and base_model_name_from_config.startswith("deployment/"): # Heuristic for deployment models
            space_id_for_watsonx = agent_config.get("space_id") or os.getenv("WATSONX_DEPLOYMENT_SPACE_ID")
            if space_id_for_watsonx:
                model_constructor_kwargs["space_id"] = space_id_for_watsonx
            else:
                logger.warn(f"WatsonX deployment model used for {adk_agent_name} but space_id not found. Deployment may fail or use default space.")


    actual_model_for_adk = LiteLlm(**model_constructor_kwargs)

    agent_kwargs = {
        "name": adk_agent_name,
        "description": agent_config.get("description"),
        "model": actual_model_for_adk,
        "instruction": agent_config.get("instruction"),
        "tools": instantiated_tools,
        "output_key": agent_config.get("outputKey"),
    }

    model_settings = agent_config.get("modelSettings", {})
    current_generate_content_config_kwargs = {} # For ADK Agent's direct model params

    if "temperature" in model_settings and model_settings["temperature"] is not None:
        try: agent_kwargs["temperature"] = float(model_settings["temperature"])
        except (ValueError, TypeError): logger.warning(f"Invalid temperature: {model_settings['temperature']}")
    if "maxOutputTokens" in model_settings and model_settings["maxOutputTokens"] is not None:
        try: agent_kwargs["max_tokens"] = int(model_settings["maxOutputTokens"]) # Renamed to max_tokens for ADK Agent
        except (ValueError, TypeError): logger.warning(f"Invalid maxOutputTokens: {model_settings['maxOutputTokens']}")
    if "topP" in model_settings and model_settings["topP"] is not None:
        try: current_generate_content_config_kwargs["top_p"] = float(model_settings["topP"])
        except (ValueError, TypeError): logger.warning(f"Invalid topP: {model_settings['topP']}")
    if "topK" in model_settings and model_settings["topK"] is not None:
        try: current_generate_content_config_kwargs["top_k"] = int(model_settings["topK"])
        except (ValueError, TypeError): logger.warning(f"Invalid topK: {model_settings['topK']}")
    if "stopSequences" in model_settings and isinstance(model_settings["stopSequences"], list):
        current_generate_content_config_kwargs["stop_sequences"] = [str(seq) for seq in model_settings["stopSequences"]]

    if current_generate_content_config_kwargs:
        # These are passed as direct kwargs to the ADK Agent constructor if supported,
        # or used to construct a GenerateContentConfig if the agent model expects that.
        # LiteLlm model wrapper in ADK might pick these up if passed to Agent.
        agent_kwargs.update(current_generate_content_config_kwargs)
        logger.info(f"Agent '{adk_agent_name}' has additional model parameters: {current_generate_content_config_kwargs}")


    return {k: v for k, v in agent_kwargs.items() if v is not None}

def generate_vertex_deployment_display_name(agent_config_name: str, agent_doc_id: str) -> str:
    base_name = agent_config_name or f"adk-agent-{agent_doc_id}"
    # Vertex AI display names must be 4-63 chars, start with letter, contain only lowercase letters, numbers, hyphens.
    sanitized_base = re.sub(r'[^a-z0-9-]+', '-', base_name.lower()).strip('-')
    if not sanitized_base: # If name was all invalid chars
        sanitized_base = f"agent-{agent_doc_id[:8]}" # Fallback using doc ID part

    # Ensure starts with a letter
    if not sanitized_base[0].isalpha():
        # Vertex display names must start with a letter.
        # Max length is 63. If prepending 'a-' makes it too long, truncate from the end of core_name.
        core_name = sanitized_base[:59] # Max 59 to allow for 'a-' prefix and ensure it's not too long
        deployment_display_name = f"a-{core_name}"
    else:
        deployment_display_name = sanitized_base

        # Ensure minimum length of 4 (Vertex requirement)
    # Ensure final length is within 63 characters
    deployment_display_name = deployment_display_name[:63]
    while len(deployment_display_name) < 4 and len(deployment_display_name) < 63 : # Check max length again here
        deployment_display_name += "x" # Pad if too short

    return deployment_display_name.strip('-')[:63] # Final strip and length check

def instantiate_tool(tool_config):
    logger.info(f"Attempting to instantiate Gofannon/Custom tool: {tool_config.get('id', 'N/A')}")
    if not isinstance(tool_config, dict):
        raise ValueError(f"Tool configuration must be a dictionary, got {type(tool_config)}")

    module_path = tool_config.get("module_path")
    class_name = tool_config.get("class_name")
    tool_type = tool_config.get("type")

    if not (tool_type == 'gofannon' or tool_type == 'custom_repo'):
        raise ValueError(f"instantiate_tool received unexpected tool type: {tool_type}. Expected 'gofannon' or 'custom_repo'.")

    if module_path and class_name:
        try:
            module = importlib.import_module(module_path)
            ToolClass = getattr(module, class_name)
            instance_specific_kwargs = tool_config.get('configuration', {})
            if instance_specific_kwargs:
                logger.info(f"Instantiating tool '{tool_config.get('id', class_name)}' with specific configuration keys: {list(instance_specific_kwargs.keys())}")
            else:
                logger.info(f"Instantiating tool '{tool_config.get('id', class_name)}' with no specific instance configuration.")

            instance = ToolClass(**instance_specific_kwargs)

            # If the tool has an 'export_to_adk' method, call it.
            # This is a convention for Gofannon tools primarily.
            if hasattr(instance, 'export_to_adk') and callable(instance.export_to_adk):
                adk_tool_spec = instance.export_to_adk()
                tool_source_type = "Gofannon-compatible tool" if tool_type == 'gofannon' else "Custom Repository tool"
                logger.info(f"Successfully instantiated and exported {tool_source_type} '{tool_config.get('id', class_name)}' to ADK spec.")
                return adk_tool_spec
            else:
                # If no export_to_adk, assume it's already an ADK-compatible tool instance.
                logger.info(f"Successfully instantiated tool '{tool_config.get('id', class_name)}' (assumed ADK native or directly compatible).")
                return instance  # Return the instance directly
        except Exception as e:
            tool_id_for_log = tool_config.get('id', class_name or 'N/A')
            if isinstance(e, (ImportError, ModuleNotFoundError)):
                logger.error(f"Error instantiating tool '{tool_id_for_log}': Could not import module '{module_path}'. Ensure this module is available in the Cloud Function's Python environment. Error: {e}\n{traceback.format_exc()}")
            else:
                logger.error(f"Error instantiating tool '{tool_id_for_log}': {e}\n{traceback.format_exc()}")
            raise ValueError(f"Error instantiating tool {tool_id_for_log}: {e}")
    else:
        raise ValueError(f"Unsupported or incomplete tool configuration for Gofannon/Custom tool ID '{tool_config.get('id', 'N/A')}' (type: {tool_type}). Missing module_path/class_name.")


def sanitize_adk_agent_name(name_str: str, prefix_if_needed: str = "agent_") -> str:
    # ADK agent names should be valid Python identifiers.
    # Replace non-alphanumeric (excluding underscore) with underscore
    sanitized = re.sub(r'[^a-zA-Z0-9_]', '_', name_str)
    # Remove leading/trailing underscores that might result from replacement
    sanitized = sanitized.strip('_')
    # If starts with a digit, prepend an underscore (or prefix_if_needed if that's more robust)
    if sanitized and sanitized[0].isdigit():
        sanitized = f"_{sanitized}" # Python ids can start with _

    # If empty after sanitization or still doesn't start with letter/_ , use prefix
    if not sanitized or not (sanitized[0].isalpha() or sanitized[0] == '_'):
        # Fallback to a more generic construction if initial sanitization fails badly
        temp_name = re.sub(r'[^a-zA-Z0-9_]', '_', name_str) # Re-sanitize original
        sanitized = f"{prefix_if_needed.strip('_')}_{temp_name.strip('_')}"
        sanitized = re.sub(r'_+', '_', sanitized).strip('_') # Consolidate multiple underscores

    if not sanitized: # Ultimate fallback if all else fails
        sanitized = f"{prefix_if_needed.strip('_')}_default_agent_name"

        # Ensure it's a valid Python identifier (simple check, not exhaustive)
    # Python identifiers: ^[a-zA-Z_][a-zA-Z0-9_]*$
    # Max length (e.g. Vertex display names often have limits like 63)
    sanitized = sanitized[:63] # Apply a practical length limit

    if not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", sanitized):
        # If it's *still* not valid (e.g., all underscores, or somehow bad), generate a safe name.
        logger.warn(f"Sanitized name '{sanitized}' from '{name_str}' is still not a valid Python identifier. Using a generic fallback.")
        generic_name = f"{prefix_if_needed.strip('_')}_{os.urandom(4).hex()}" # Random suffix for uniqueness
        return generic_name[:63] # Ensure length constraint

    return sanitized

async def instantiate_adk_agent_from_config(agent_config, parent_adk_name_for_context="root", child_index=0): # Made async
    original_agent_name = agent_config.get('name', f'agent_cfg_{child_index}')
    # Make ADK agent names more unique to avoid conflicts if multiple deployments happen
    # or if names are similar across different parts of a composite agent.
    unique_base_name_for_adk = f"{original_agent_name}_{parent_adk_name_for_context}_{os.urandom(2).hex()}"
    adk_agent_name = sanitize_adk_agent_name(unique_base_name_for_adk, prefix_if_needed=f"agent_{child_index}_")

    agent_type_str = agent_config.get("agentType")
    AgentClass = {
        "Agent": Agent, # This is LlmAgent
        "SequentialAgent": SequentialAgent,
        "LoopAgent": LoopAgent,
        "ParallelAgent": ParallelAgent
    }.get(agent_type_str)

    if not AgentClass:
        error_msg = f"Invalid agentType specified: '{agent_type_str}' for agent config: {original_agent_name}"
        logger.error(error_msg)
        raise ValueError(error_msg)

    logger.info(f"Instantiating ADK Agent: Name='{adk_agent_name}', Type='{AgentClass.__name__}', Original Config Name='{original_agent_name}' (Context: parent='{parent_adk_name_for_context}', index={child_index})")

    if AgentClass == Agent: # LlmAgent
        agent_kwargs = await _prepare_agent_kwargs_from_config( # Await the async call
            agent_config,
            adk_agent_name,
            context_for_log=f"(type: LlmAgent, parent: {parent_adk_name_for_context}, original: {original_agent_name})"
        )
        tool_count = len(agent_kwargs.get("tools", []))
        logger.info(f"Final kwargs for LlmAgent '{adk_agent_name}' includes {tool_count} tools")

        try:
            return Agent(**agent_kwargs)
        except Exception as e_agent_init:
            logger.error(f"Initialization Error for LlmAgent '{adk_agent_name}' (from config '{original_agent_name}'): {e_agent_init}")
            logger.error(f"Args passed: {agent_kwargs}") # Log the arguments that caused the error
            detailed_traceback = traceback.format_exc()
            logger.error(f"Traceback:\n{detailed_traceback}")
            raise ValueError(f"Failed to instantiate LlmAgent '{original_agent_name}': {e_agent_init}.")


    elif AgentClass == SequentialAgent or AgentClass == ParallelAgent:
        child_agent_configs = agent_config.get("childAgents", [])
        if not child_agent_configs:
            logger.info(f"{AgentClass.__name__} '{original_agent_name}' has no child agents configured.")
            instantiated_child_agents = []
        else:
            instantiated_child_agents = []
            for idx, child_config in enumerate(child_agent_configs):
                try:
                    # Basic validation/defaulting for child agent configs if necessary
                    if 'selectedProviderId' not in child_config: # Example default
                        logger.warn(f"Child agent config for '{child_config.get('name', 'N/A')}' (index {idx}) is missing 'selectedProviderId'. Defaulting to OpenAI (example).")
                        child_config['selectedProviderId'] = "openai" # Or a more sensible default
                    if 'litellm_model_string' not in child_config:
                        logger.warn(f"Child agent config for '{child_config.get('name', 'N/A')}' (index {idx}) is missing 'litellm_model_string'. Defaulting to gpt-3.5-turbo (example).")
                        child_config['litellm_model_string'] = "gpt-3.5-turbo" # Example default

                    child_agent_instance = await instantiate_adk_agent_from_config( # Await the recursive async call
                        child_config,
                        parent_adk_name_for_context=adk_agent_name, # Pass current agent's ADK name as context
                        child_index=idx
                    )
                    instantiated_child_agents.append(child_agent_instance)
                except Exception as e_child:
                    logger.error(f"Failed to instantiate child agent at index {idx} for {AgentClass.__name__} '{original_agent_name}': {e_child}")
                    # Potentially re-raise or handle to allow partial construction if desired
                    raise ValueError(f"Error processing child agent for '{original_agent_name}': {e_child}")

        orchestrator_kwargs = {
            "name": adk_agent_name,
            "description": agent_config.get("description"),
            "sub_agents": instantiated_child_agents
        }
        logger.debug(f"Final kwargs for {AgentClass.__name__} '{adk_agent_name}': {{name, description, num_sub_agents: {len(instantiated_child_agents)}}}")
        return AgentClass(**orchestrator_kwargs)

    elif AgentClass == LoopAgent:
        # LoopAgent wraps a single LlmAgent (defined by the LoopAgent's own config fields)
        looped_agent_config_name = f"{original_agent_name}_looped_child_config" # For logging
        looped_agent_adk_name = sanitize_adk_agent_name(f"{adk_agent_name}_looped_child_instance", prefix_if_needed="looped_")

        # The LoopAgent's main config (instruction, model, tools) defines the agent to be looped.
        looped_agent_kwargs = await _prepare_agent_kwargs_from_config( # Await the async call
            agent_config, # Pass the main agent_config, as LoopAgent's own config defines the looped agent
            looped_agent_adk_name,
            context_for_log=f"(looped child of LoopAgent '{adk_agent_name}', original config: '{looped_agent_config_name}')"
        )
        logger.debug(f"Final kwargs for Looped Child ADK Agent '{looped_agent_adk_name}' (for LoopAgent '{adk_agent_name}'): {looped_agent_kwargs}")
        try:
            looped_child_agent_instance = Agent(**looped_agent_kwargs) # Agent is LlmAgent
        except Exception as e_loop_child_init:
            logger.error(f"Initialization Error for Looped Child Agent '{looped_agent_adk_name}' (from config '{looped_agent_config_name}'): {e_loop_child_init}")
            logger.error(f"Args passed to looped child Agent constructor: {looped_agent_kwargs}")
            detailed_traceback = traceback.format_exc()
            logger.error(f"Traceback:\n{detailed_traceback}")
            raise ValueError(f"Failed to instantiate looped child agent for '{original_agent_name}': {e_loop_child_init}.")

        max_loops_val_str = agent_config.get("maxLoops", "3") # Default to 3 loops
        try:
            max_loops_val = int(max_loops_val_str)
            if max_loops_val <= 0: # Max loops must be positive
                logger.warning(f"MaxLoops for LoopAgent '{adk_agent_name}' is {max_loops_val}, which is not positive. Defaulting to 3.")
                max_loops_val = 3
        except ValueError:
            logger.warning(f"Invalid MaxLoops value '{max_loops_val_str}' for LoopAgent '{adk_agent_name}'. Defaulting to 3.")
            max_loops_val = 3


        loop_agent_kwargs = {
            "name": adk_agent_name,
            "description": agent_config.get("description"),
            "agent": looped_child_agent_instance, # The LlmAgent to loop
            "max_loops": max_loops_val
            # Potentially other LoopAgent specific params like "stopping_condition" if supported/configured
        }
        logger.debug(f"Final kwargs for LoopAgent '{adk_agent_name}': {{name, description, max_loops, agent_name: {looped_child_agent_instance.name}}}")
        return LoopAgent(**loop_agent_kwargs)

    else:
        # This case should be caught by the AgentClass check at the beginning
        raise ValueError(f"Unhandled agent type '{agent_type_str}' during recursive instantiation for '{original_agent_name}'.")


__all__ = [
    'generate_vertex_deployment_display_name',
    'instantiate_tool',
    'sanitize_adk_agent_name',
    'instantiate_adk_agent_from_config'
]