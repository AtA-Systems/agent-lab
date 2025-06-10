// src/components/agents/AgentRunner.js
import React, { useState, useRef, useEffect } from 'react';
import { queryAgent } from '../../services/agentService'; // Ensure this is the updated one
import ErrorMessage from '../common/ErrorMessage';
import AgentReasoningLogDialog from './AgentReasoningLogDialog';
import { muiMarkdownComponentsConfig } from '../common/MuiMarkdownComponents';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
    Paper, Typography, TextField, Button, Box, List, ListItem,
    ListItemText, Avatar, CircularProgress, IconButton, Tooltip, Alert, AlertTitle,
    CircularProgress as MuiCircularProgress // Renamed to avoid conflict
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import PersonIcon from '@mui/icons-material/Person';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import DeveloperModeIcon from '@mui/icons-material/DeveloperMode';
import LiveTvIcon from '@mui/icons-material/LiveTv';
import Inventory2Icon from '@mui/icons-material/Inventory2'; // For artifacts
import DatasetLinkedIcon from '@mui/icons-material/DatasetLinked'; // For context

// New imports for context stuffing
import ContextStuffingDropdown from '../context_stuffing/ContextStuffingDropdown';
import WebPageContextModal from '../context_stuffing/WebPageContextModal';
import GitRepoContextModal from '../context_stuffing/GitRepoContextModal';
import PdfContextModal from '../context_stuffing/PdfContextModal';
import ContextDisplayBubble from '../context_stuffing/ContextDisplayBubble';
import ContextDetailsDialog from '../context_stuffing/ContextDetailsDialog';

// Import the actual service functions (ensure these are created in contextService.js)
import { fetchWebPageContent, fetchGitRepoContents, processPdfContent } from '../../services/contextService';


// Helper function to extract artifact updates (can be moved to a utils file if needed)
const extractArtifactUpdates = (events) => {
    const updates = {};
    if (!events || !Array.isArray(events)) return null;

    events.forEach(event => {
        if (event && event.actions && event.actions.artifact_delta) {
            for (const [filename, versionInfo] of Object.entries(event.actions.artifact_delta)) {
                let versionDisplay = versionInfo;
                if (typeof versionInfo === 'object' && versionInfo !== null && 'version' in versionInfo) {
                    versionDisplay = versionInfo.version;
                } else if (typeof versionInfo === 'number') {
                    versionDisplay = versionInfo;
                } else if (typeof versionInfo === 'object' && versionInfo !== null) {
                    versionDisplay = JSON.stringify(versionInfo);
                }
                updates[filename] = versionDisplay;
            }
        }
    });
    return Object.keys(updates).length > 0 ? updates : null;
};


const AgentRunner = ({
                         agentResourceName,
                         agentFirestoreId,
                         adkUserId,
                         historicalRunData,
                         onSwitchToLiveChat,
                         isLiveModeEnabled
                     }) => {
    const [message, setMessage] = useState('');
    const [conversation, setConversation] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const [currentSessionId, setCurrentSessionId] = useState(null);
    const conversationEndRef = useRef(null);

    const [isReasoningLogOpen, setIsReasoningLogOpen] = useState(false);
    const [selectedEventsForLog, setSelectedEventsForLog] = useState([]);

    // New states for context stuffing
    const [contextModalType, setContextModalType] = useState(null); // 'webpage', 'gitrepo', 'pdf'
    const [isContextModalOpen, setIsContextModalOpen] = useState(false);
    const [isContextDetailsOpen, setIsContextDetailsOpen] = useState(false);
    const [selectedContextItemsForDetails, setSelectedContextItemsForDetails] = useState([]);
    const [isContextLoading, setIsContextLoading] = useState(false);


    const isHistoricalView = !!historicalRunData;

    const scrollToBottom = () => {
        conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(scrollToBottom, [conversation]);

    useEffect(() => {
        if (isHistoricalView && historicalRunData) {
            const historicalConversation = [];
            // Add historical user message first
            historicalConversation.push({
                type: 'user',
                text: historicalRunData.inputMessage,
                timestamp: historicalRunData.timestamp?.toDate ? historicalRunData.timestamp.toDate() : new Date(),
            });

            let agentEvents = [];
            let artifactUpdatesForHistorical = null;
            let stuffedContextFromHistory = null;

            try {
                agentEvents = historicalRunData.outputEventsRaw ? JSON.parse(historicalRunData.outputEventsRaw) : [];
                artifactUpdatesForHistorical = extractArtifactUpdates(agentEvents);

                if (historicalRunData.stuffedContextItems) {
                    stuffedContextFromHistory = typeof historicalRunData.stuffedContextItems === 'string'
                        ? JSON.parse(historicalRunData.stuffedContextItems)
                        : historicalRunData.stuffedContextItems;
                }
            } catch (parseError) {
                console.error("Error parsing historical run events/context:", parseError);
                agentEvents = [{ type: "error", content: "Error parsing raw events." }];
            }

            // If historical context exists, insert it BEFORE the user message that consumed it
            // This assumes the inputMessage in Firestore is the user's query *after* context was stuffed
            // If context was meant to be prepended, the logic in handleSendMessage would have done that
            // before saving. For display, we can show it before the user's explicit part.
            if (stuffedContextFromHistory && stuffedContextFromHistory.length > 0) {
                const userMessageIndex = historicalConversation.findIndex(msg => msg.type === 'user');
                const contextMessageTime = historicalRunData.timestamp?.toDate
                    ? new Date(historicalRunData.timestamp.toDate().getTime() - 1000) // Slightly before user message
                    : new Date();

                const contextBubble = {
                    type: 'stuffed_context_history',
                    items: stuffedContextFromHistory,
                    timestamp: contextMessageTime,
                };
                if (userMessageIndex !== -1) {
                    historicalConversation.splice(userMessageIndex, 0, contextBubble);
                } else {
                    historicalConversation.unshift(contextBubble); // Add to beginning if no user message found (unlikely)
                }
            }


            // Add agent response
            historicalConversation.push({
                type: 'agent',
                text: historicalRunData.finalResponseText || "Agent did not provide a text response.",
                events: agentEvents,
                timestamp: historicalRunData.timestamp?.toDate ? new Date(historicalRunData.timestamp.toDate().getTime() + 1000) : new Date(), // Slightly after user message
                queryErrorDetails: historicalRunData.queryErrorDetails || null,
                artifactUpdates: artifactUpdatesForHistorical
            });

            setConversation(historicalConversation);
            setMessage('');
            setError(null);
            setCurrentSessionId(null); // No live session for historical view
        } else if (!isHistoricalView) {
            // If switching from historical to live and not reloading, reset conversation
            if (conversation.some(c => c.type === 'stuffed_context_history')) {
                setConversation([]); // Clear if it contains historical context markers
            }
        }
    }, [historicalRunData, isHistoricalView]);


    const handleOpenReasoningLog = (events) => {
        setSelectedEventsForLog(events || []);
        setIsReasoningLogOpen(true);
    };
    const handleCloseReasoningLog = () => setIsReasoningLogOpen(false);

    // Context Stuffing Modal Handlers
    const handleContextOptionSelected = (option) => {
        setContextModalType(option);
        setIsContextModalOpen(true);
    };
    const handleCloseContextModal = () => {
        setIsContextModalOpen(false);
        setContextModalType(null);
    };

    const handleOpenContextDetails = (items) => {
        setSelectedContextItemsForDetails(items);
        setIsContextDetailsOpen(true);
    };
    const handleCloseContextDetails = () => setIsContextDetailsOpen(false);

    const handleContextSubmit = async (params) => {
        setIsContextLoading(true);
        setError(null);
        let newContextItems = [];
        try {
            if (params.type === 'webpage') {
                const result = await fetchWebPageContent(params.url);
                if (result.success) {
                    newContextItems.push({ name: result.name, content: result.content, type: 'webpage', bytes: result.content?.length || 0 });
                } else {
                    throw new Error(result.message || "Failed to fetch web page.");
                }
            } else if (params.type === 'gitrepo') {
                const result = await fetchGitRepoContents(params);
                if (result.success && result.items) {
                    newContextItems = result.items.map(item => ({
                        name: item.name,
                        content: item.content,
                        type: item.type,
                        bytes: item.content?.length || 0
                    }));
                } else {
                    throw new Error(result.message || "Failed to fetch Git repository contents.");
                }
            } else if (params.type === 'pdf') {
                const result = await processPdfContent(params);
                if (result.success) {
                    newContextItems.push({ name: result.name, content: result.content, type: result.type, bytes: result.content?.length || 0 });
                } else {
                    throw new Error(result.message || "Failed to process PDF.");
                }
            }

            const validContextItems = newContextItems.filter(item => item.type !== 'gitfile_error' && item.type !== 'gitfile_skipped' && item.type !== 'pdf_error');
            const errorContextItems = newContextItems.filter(item => item.type === 'gitfile_error' || item.type === 'gitfile_skipped' || item.type === 'pdf_error');

            if (validContextItems.length > 0) {
                setConversation(prev => [...prev, {
                    type: 'stuffed_context', // Use this type for live stuffing
                    items: validContextItems,
                    timestamp: new Date()
                }]);
            }
            if (errorContextItems.length > 0) {
                errorContextItems.forEach(errItem => {
                    setConversation(prev => [...prev, { type: 'error', text: `Context Fetch Error for "${errItem.name}": ${errItem.content}`, timestamp: new Date() }]);
                });
                if (validContextItems.length === 0) setError("Some context items could not be fetched/processed. See chat for details.");
            }

        } catch (err) {
            console.error("Error stuffing context:", err);
            const displayError = err.details?.message || err.message || "An unexpected error occurred while fetching context.";
            setError(`Failed to stuff context: ${displayError}`);
            setConversation(prev => [...prev, { type: 'error', text: `Context Fetch Error: ${displayError}`, timestamp: new Date() }]);
        } finally {
            setIsContextLoading(false);
        }
    };


    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (isHistoricalView) return;

        let lastProperMessageIndex = -1;
        for (let i = conversation.length - 1; i >= 0; i--) {
            if (['user', 'agent', 'error'].includes(conversation[i].type)) {
                lastProperMessageIndex = i;
                break;
            }
        }

        const recentContextMessages = conversation.slice(lastProperMessageIndex + 1);
        const activeContextItems = [];
        recentContextMessages.forEach(convItem => {
            if (convItem.type === 'stuffed_context' && convItem.items) {
                activeContextItems.push(...convItem.items);
            }
        });

        const userQueryText = message.trim();

        if (!userQueryText && activeContextItems.length === 0) {
            // If no text input AND no new context items were just added, do nothing.
            return;
        }

        let combinedMessageForAgent = userQueryText;
        if (activeContextItems.length > 0) {
            const contextString = activeContextItems.map(item =>
                `File: ${item.name}\n\`\`\`\n${item.content}\n\`\`\`\n` // Format for LLM
            ).join('\n---\n');
            combinedMessageForAgent = `${contextString}\n---\nUser Query:\n${userQueryText || "[No explicit user query, process provided context]"}`;
        }

        // Display user's part of the message (what they typed, or indication of context-only)
        const userMessageDisplay = userQueryText || (activeContextItems.length > 0 ? "[Sending context to agent]" : "[Empty message - should not happen]");
        const userMessageEntry = { type: 'user', text: userMessageDisplay, timestamp: new Date() };

        // Add user message to conversation *after* any context bubbles they just triggered
        // but before the agent's response.
        // The context bubbles are already in `conversation` from `handleContextSubmit`.
        setConversation(prev => [...prev, userMessageEntry]);

        setMessage(''); // Clear input field
        setIsLoading(true);
        setError(null);

        try {
            const result = await queryAgent(
                agentResourceName,
                combinedMessageForAgent,
                adkUserId,
                currentSessionId,
                agentFirestoreId,
                activeContextItems // Pass the clean context items for logging
            );

            const agentEvents = result.events || [];
            const artifactUpdates = extractArtifactUpdates(agentEvents);

            const agentResponse = {
                type: 'agent',
                text: result.responseText || "Agent responded.",
                events: agentEvents,
                timestamp: new Date(),
                queryErrorDetails: result.queryErrorDetails || null,
                artifactUpdates: artifactUpdates
            };

            if (result.success) {
                setConversation(prev => [...prev, agentResponse]);
                if (result.adkSessionId) {
                    setCurrentSessionId(result.adkSessionId);
                }
            } else {
                const errorMessage = result.message || "Agent query failed. No specific error message.";
                setError(errorMessage);
                agentResponse.type = 'error';
                agentResponse.text = `Query Failed: ${errorMessage}`;
                setConversation(prev => [...prev, agentResponse]);
            }

        } catch (err) {
            const errorMessage = err.message || "An error occurred while querying the agent.";
            setError(errorMessage);
            const errorResponse = { type: 'error', text: errorMessage, timestamp: new Date() };
            setConversation(prev => [...prev, errorResponse]);
        } finally {
            setIsLoading(false);
        }
    };


    const handleResetSessionOrSwitchMode = () => {
        if (isHistoricalView) {
            onSwitchToLiveChat(); // This should trigger state change in parent, unsetting historicalRunData
        } else {
            setCurrentSessionId(null);
            setConversation([]);
            setError(null);
        }
    };

    const getAvatar = (type) => {
        if (type === 'user') return <Avatar sx={{ bgcolor: 'primary.main' }}><PersonIcon /></Avatar>;
        if (type === 'agent') return <Avatar sx={{ bgcolor: 'secondary.main' }}><SmartToyIcon /></Avatar>;
        // Use a consistent icon for both live and historical context messages
        if (type === 'stuffed_context' || type === 'stuffed_context_history') return <Avatar sx={{bgcolor: 'info.main', width: 32, height: 32 }}><DatasetLinkedIcon sx={{fontSize: '1rem'}}/></Avatar>;
        return <Avatar sx={{ bgcolor: 'error.main' }}><ErrorOutlineIcon /></Avatar>;
    };

    const runnerTitle = isHistoricalView ? "Run History Viewer" : "Run Agent (Live)";
    const canAttemptLiveChat = !isHistoricalView && isLiveModeEnabled;

    // Determine if the send button should be enabled
    const hasNewContextToProcess = conversation.slice(
        conversation.slice().reverse().findIndex(m => ['user','agent','error'].includes(m.type)) +1 // find last "proper" message
    ).some(m => m.type === 'stuffed_context');

    const sendButtonDisabled = isLoading || isContextLoading || isHistoricalView || (!message.trim() && !hasNewContextToProcess);


    return (
        <Paper elevation={3} sx={{ p: { xs: 2, md: 3 }, mt: 4 }}>
            <Box sx={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb:1}}>
                <Typography variant="h5" component="h2" gutterBottom>
                    {runnerTitle}
                </Typography>
                {isLiveModeEnabled && (
                    <Button
                        onClick={handleResetSessionOrSwitchMode}
                        startIcon={isHistoricalView ? <LiveTvIcon /> : <RestartAltIcon />}
                        color={isHistoricalView ? "primary" : "warning"}
                        variant="outlined"
                        size="small"
                        disabled={!isHistoricalView && (isLoading || isContextLoading)}
                    >
                        {isHistoricalView ? "Back to Live Chat" : "Reset Live Chat"}
                    </Button>
                )}
            </Box>

            {isHistoricalView && historicalRunData && (
                <Alert severity="info" sx={{mb:2}}>
                    You are viewing a historical run from {new Date(historicalRunData.timestamp?.toDate()).toLocaleString()}.
                    Input is disabled.
                </Alert>
            )}
            {!isLiveModeEnabled && !isHistoricalView && (
                <Alert severity="warning" sx={{mb:2}}>
                    Live agent interaction is not available. The agent might not be deployed or accessible.
                </Alert>
            )}

            {!isHistoricalView && error && <ErrorMessage message={error} severity="error" sx={{ mb: 2 }} />}
            {isContextLoading && !isHistoricalView &&
                <Box sx={{display: 'flex', justifyContent:'center', alignItems: 'center', my: 1.5}}>
                    <MuiCircularProgress size={20} sx={{mr:1}} />
                    <Typography variant="body2" color="text.secondary">Fetching context...</Typography>
                </Box>
            }


            <Box
                sx={{
                    height: '400px',
                    overflowY: 'auto',
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 1,
                    p: 2,
                    mb: 2,
                    bgcolor: 'background.paper',
                }}
            >
                <List>
                    {conversation.map((entry, index) => (
                        <ListItem key={index} sx={{
                            display: 'flex',
                            // For context bubbles, align them to the user's side (right)
                            flexDirection: (entry.type === 'user' || entry.type === 'stuffed_context' || entry.type === 'stuffed_context_history') ? 'row-reverse' : 'row',
                            mb: 1,
                            alignItems: 'flex-start',
                        }}>
                            {/* Conditionally render avatar or use full width for context bubble */}
                            { (entry.type !== 'stuffed_context' && entry.type !== 'stuffed_context_history') ? getAvatar(entry.type) : null }

                            { (entry.type === 'stuffed_context' || entry.type === 'stuffed_context_history') ? (
                                <Box sx={{ width: '100%', display: 'flex', justifyContent: 'flex-end', alignItems:'center', my: 0.5 }}>
                                    {getAvatar(entry.type)}
                                    <Box sx={{ml: (entry.type !== 'user' && entry.type !== 'stuffed_context' && entry.type !== 'stuffed_context_history') ? 1.5 : 0,
                                        mr: (entry.type === 'user' || entry.type === 'stuffed_context' || entry.type === 'stuffed_context_history') ? 1.5 : 0,
                                        maxWidth:'80%'}}>
                                        <ContextDisplayBubble
                                            contextMessage={entry}
                                            onOpenDetails={() => handleOpenContextDetails(entry.items)}
                                        />
                                    </Box>
                                </Box>
                            ) : (
                                <Paper
                                    elevation={1}
                                    sx={{
                                        p: 1.5,
                                        ml: (entry.type !== 'user') ? 1.5 : 0,
                                        mr: (entry.type === 'user') ? 1.5 : 0,
                                        bgcolor: entry.type === 'user' ? 'primary.light' :
                                            entry.type === 'agent' ? (entry.queryErrorDetails ? 'warning.light' : 'grey.200') :
                                                'error.light',
                                        color: entry.type === 'user' ? 'primary.contrastText' :
                                            entry.type === 'agent' ? (entry.queryErrorDetails ? 'warning.contrastText' : 'text.primary') :
                                                'error.contrastText',
                                        maxWidth: '80%',
                                        wordBreak: 'break-word',
                                        position: 'relative',
                                    }}
                                >
                                    <ListItemText
                                        disableTypography
                                        primary={
                                            entry.type === 'agent' ? (
                                                <ReactMarkdown
                                                    remarkPlugins={[remarkGfm]}
                                                    components={muiMarkdownComponentsConfig}
                                                >
                                                    {entry.text}
                                                </ReactMarkdown>
                                            ) : entry.type === 'user' ? (
                                                <Typography variant="body1">{entry.text}</Typography>
                                            ) : (
                                                <Typography variant="body1" color={entry.type === 'agent' && entry.queryErrorDetails ? 'warning.contrastText' : 'error.contrastText' }>{entry.text}</Typography>
                                            )
                                        }
                                        secondary={
                                            <Typography
                                                variant="caption"
                                                sx={{
                                                    display: 'block',
                                                    textAlign: entry.type === 'user' ? 'right' : 'left',
                                                    mt: 0.5,
                                                    color: entry.type === 'user' ? 'primary.contrastText' :
                                                        entry.type === 'agent' ? (entry.queryErrorDetails ? 'warning.contrastText' : 'text.secondary') :
                                                            'error.contrastText',
                                                    opacity: entry.type === 'user' ? 0.8 : 1,
                                                }}
                                            >
                                                {new Date(entry.timestamp).toLocaleTimeString()}
                                                {entry.type === 'agent' && currentSessionId && !isHistoricalView && ` (S: ...${currentSessionId.slice(-4)})`}
                                                {entry.type === 'agent' && isHistoricalView && historicalRunData?.adkSessionId && ` (S: ...${historicalRunData.adkSessionId.slice(-4)})`}
                                            </Typography>
                                        }
                                    />
                                    {entry.type === 'agent' && entry.artifactUpdates && (
                                        <Box mt={1} sx={{ borderTop: '1px dashed', borderColor: 'divider', pt: 1, opacity: 0.8}}>
                                            <Typography variant="caption" display="flex" alignItems="center" sx={{fontWeight: 'medium', color: entry.queryErrorDetails ? 'warning.contrastText' : 'text.secondary' }}>
                                                <Inventory2Icon fontSize="inherit" sx={{mr:0.5, verticalAlign: 'middle'}}/> Artifacts Updated:
                                            </Typography>
                                            <Box component="ul" sx={{pl: 2, m:0, listStyleType:'none'}}>
                                                {Object.entries(entry.artifactUpdates).map(([filename, version]) => (
                                                    <Typography component="li" key={filename} variant="caption" display="block" sx={{fontSize: '0.7rem', color: entry.queryErrorDetails ? 'warning.contrastText' : 'text.secondary'}}>
                                                        {filename} (v{version})
                                                    </Typography>
                                                ))}
                                            </Box>
                                        </Box>
                                    )}
                                    {entry.type === 'agent' && entry.queryErrorDetails && entry.queryErrorDetails.length > 0 && (
                                        <Alert
                                            severity="warning"
                                            sx={{
                                                mt: 1, fontSize: '0.8rem', bgcolor: 'transparent', color: 'inherit',
                                                '& .MuiAlert-icon': { color: 'inherit', fontSize: '1.1rem', mr:0.5, pt:0.2 },
                                                border: (theme) => `1px solid ${theme.palette.warning.dark}`, p:1,
                                            }}
                                            iconMapping={{ warning: <ErrorOutlineIcon fontSize="inherit" /> }}
                                        >
                                            <AlertTitle sx={{ fontSize: '0.9rem', fontWeight: 'bold', mb:0.5 }}>Agent Diagnostics:</AlertTitle>
                                            <Box component="ul" sx={{ margin: 0, paddingLeft: '20px', listStyleType: 'disc', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight:'150px', overflowY:'auto' }}>
                                                {entry.queryErrorDetails.map((err, i) => (
                                                    <Typography component="li" variant="caption" key={i} sx={{display:'list-item'}}>{typeof err === 'object' ? JSON.stringify(err) : err}</Typography>
                                                ))}
                                            </Box>
                                            {(!entry.text || entry.text.trim() === "Agent responded." || entry.text.trim() === "") && (
                                                <Typography variant="caption" display="block" sx={{mt:1, fontStyle:'italic'}}>
                                                    The agent may not have provided a complete response due to these issues.
                                                </Typography>
                                            )}
                                        </Alert>
                                    )}
                                    {entry.type === 'agent' && entry.events && entry.events.length > 0 && (
                                        <Tooltip title="View Agent Reasoning Log" placement="top">
                                            <IconButton
                                                size="small"
                                                onClick={() => handleOpenReasoningLog(entry.events)}
                                                sx={{
                                                    position: 'absolute', bottom: 2, right: 2,
                                                    color: (theme) => theme.palette.action.active,
                                                    '&:hover': { bgcolor: (theme) => theme.palette.action.hover }
                                                }}
                                                aria-label="view agent reasoning"
                                            >
                                                <DeveloperModeIcon fontSize="inherit" />
                                            </IconButton>
                                        </Tooltip>
                                    )}
                                </Paper>
                            )}
                        </ListItem>
                    ))}
                    {!isHistoricalView && isLoading && (
                        <ListItem sx={{ justifyContent: 'flex-start', mb: 1 }}>
                            <Avatar sx={{ bgcolor: 'secondary.main' }}><SmartToyIcon /></Avatar>
                            <Paper elevation={1} sx={{ p: 1.5, ml: 1.5, bgcolor: 'grey.200', display: 'inline-flex', alignItems: 'center' }}>
                                <CircularProgress size={20} sx={{ mr: 1 }} />
                                <Typography variant="body2" color="text.secondary">Agent is thinking...</Typography>
                            </Paper>
                        </ListItem>
                    )}
                    <div ref={conversationEndRef} />
                </List>
            </Box>

            {canAttemptLiveChat && (
                <Box component="form" onSubmit={handleSendMessage} sx={{ display: 'flex', alignItems: 'flex-end', gap: 1 }}>
                    <TextField
                        fullWidth
                        variant="outlined"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="Type your message to the agent..."
                        disabled={isLoading || isContextLoading || isHistoricalView}
                        onKeyPress={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(e);}}}
                        size="small"
                        multiline
                        maxRows={5}
                    />
                    <ContextStuffingDropdown
                        onOptionSelected={handleContextOptionSelected}
                        disabled={isLoading || isContextLoading || isHistoricalView}
                    />
                    <Button
                        type="submit"
                        variant="contained"
                        color="primary"
                        disabled={sendButtonDisabled}
                        endIcon={<SendIcon />}
                        sx={{ height: '100%', alignSelf: 'stretch' }} // was flex-end
                    >
                        Send
                    </Button>
                </Box>
            )}

            <AgentReasoningLogDialog
                open={isReasoningLogOpen}
                onClose={handleCloseReasoningLog}
                events={selectedEventsForLog}
            />
            {isContextModalOpen && contextModalType === 'webpage' && (
                <WebPageContextModal open={isContextModalOpen} onClose={handleCloseContextModal} onSubmit={handleContextSubmit} />
            )}
            {isContextModalOpen && contextModalType === 'gitrepo' && (
                <GitRepoContextModal open={isContextModalOpen} onClose={handleCloseContextModal} onSubmit={handleContextSubmit} />
            )}
            {isContextModalOpen && contextModalType === 'pdf' && (
                <PdfContextModal open={isContextModalOpen} onClose={handleCloseContextModal} onSubmit={handleContextSubmit} />
            )}
            <ContextDetailsDialog
                open={isContextDetailsOpen}
                onClose={handleCloseContextDetails}
                contextItems={selectedContextItemsForDetails}
            />
        </Paper>
    );
};

export default AgentRunner;  