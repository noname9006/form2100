const fs = require('fs');
const path = require('path');
const messages = require('./message.js');

class TicketSender {
    constructor(client) {
        this.client = client;
        this.TICKET_CATEGORY = process.env.TICKET_CAT;
        this.CLOSE_HOURS = parseFloat(process.env.CLOSE_HOURS) || 1;
        this.DELETE_HOURS = parseFloat(process.env.DELETE_HOURS) || 24;
        this.DEBUG_MODE = process.env.DEBUG_MODE === 'true';
        
        this.activeTickets = new Map(); // Track active tickets
        this.pendingClosures = new Map(); // Track channels waiting to be closed
        
        // Statistics tracking
        this.stats = {
            ticketsCreated: 0,
            ticketsCompleted: 0,
            ticketsClosed: 0,
            slashCommandsExecuted: 0,
            errors: 0,
            startTime: new Date()
        };
        
        this.log('🚀 TicketSender initialized', {
            ticketCategory: this.TICKET_CATEGORY,
            closeHours: this.CLOSE_HOURS,
            debugMode: this.DEBUG_MODE
        });
    }

    /**
     * Enhanced logging with timestamps and context
     */
    log(message, context = {}, level = 'INFO') {
        const timestamp = new Date().toISOString().replace('T', ' ').replace(/\..+/, '');
        const contextStr = Object.keys(context).length > 0 ? JSON.stringify(context, null, 2) : '';
        
        console.log(`[${timestamp}] [TICKET-${level}] ${message}`);
        if (contextStr && (this.DEBUG_MODE || level === 'ERROR')) {
            console.log(`[${timestamp}] [TICKET-CONTEXT] ${contextStr}`);
        }
    }

    /**
     * Error logging with stack traces
     */
    logError(message, error, context = {}) {
        this.stats.errors++;
        this.log(`❌ ${message}`, {
            ...context,
            error: error.message,
            stack: error.stack
        }, 'ERROR');
    }

    /**
     * Debug logging (only shown in debug mode)
     */
    debug(message, context = {}) {
        if (this.DEBUG_MODE) {
            this.log(`🔍 ${message}`, context, 'DEBUG');
        }
    }

    /**
     * Performance timing utility
     */
    startTimer(operation) {
        const start = Date.now();
        return {
            end: () => {
                const duration = Date.now() - start;
                this.debug(`⏱️ ${operation} completed`, { durationMs: duration });
                return duration;
            }
        };
    }

    /**
     * Initialize the sender and set up event listeners
     */
    init() {
        this.log('🎯 Initializing event listeners');
        
        this.client.on('channelCreate', (channel) => {
            this.handleChannelCreation(channel).catch(error => {
                this.logError('Failed in channelCreate handler', error, { channelId: channel.id });
            });
        });

        this.client.on('messageCreate', (message) => {
            this.handleUserMessage(message).catch(error => {
                this.logError('Failed in messageCreate handler', error, { 
                    messageId: message.id,
                    channelId: message.channel.id,
                    authorId: message.author?.id
                });
            });
        });

        // Periodic status reporting
        setInterval(() => {
            this.logStatus();
        }, 30 * 60 * 1000); // Every 30 minutes

        this.log('✅ Event listeners initialized successfully');
    }

    /**
     * Log current system status
     */
    logStatus() {
        const uptime = Date.now() - this.stats.startTime.getTime();
        this.log('📊 System Status Report', {
            uptime: `${Math.floor(uptime / 1000 / 60)} minutes`,
            activeTickets: this.activeTickets.size,
            pendingClosures: this.pendingClosures.size,
            stats: this.stats
        });
    }

    /**
     * Handle new channel creation
     */
    async handleChannelCreation(channel) {
        const timer = this.startTimer('handleChannelCreation');
        
        try {
            this.log('📝 Channel created', {
                channelId: channel.id,
                channelName: channel.name,
                parentId: channel.parentId,
                targetCategory: this.TICKET_CATEGORY
            });

            // Check if channel is created in the target category
            if (channel.parentId !== this.TICKET_CATEGORY) {
                this.debug('Channel not in target category, ignoring', {
                    channelId: channel.id,
                    parentId: channel.parentId
                });
                return;
            }

            this.log('🎫 Processing new ticket channel', { channelId: channel.id });
            this.stats.ticketsCreated++;

            // Wait for the first message to appear
            const firstMessage = await this.waitForFirstMessage(channel);
            if (!firstMessage) {
                this.log('⚠️ No first message found in channel', { channelId: channel.id });
                return;
            }

            this.log('📩 First message received', {
                channelId: channel.id,
                messageId: firstMessage.id,
                authorId: firstMessage.author.id,
                contentLength: firstMessage.content.length
            });

            // Extract user tag from first message
            const userTag = this.extractUserTag(firstMessage);
            if (!userTag) {
                this.log('⚠️ Could not extract user tag from first message', {
                    channelId: channel.id,
                    messageId: firstMessage.id
                });
                return;
            }

            this.log('👤 User tag extracted', { channelId: channel.id, userTag });

            // Send initial automated message
            const sentMessage = await channel.send(messages.INITIAL_MESSAGE.replace('{userTag}', userTag));
            this.log('📤 Initial automated message sent', {
                channelId: channel.id,
                messageId: sentMessage.id,
                userTag
            });

            // Track this ticket
            const ticketData = {
                channelId: channel.id,
                userTag: userTag,
                createdAt: new Date(),
                awaitingResponse: true,
                hasEvmAddress: false,
                hasImage: false,
                initialMessageId: sentMessage.id
            };

            this.activeTickets.set(channel.id, ticketData);
            this.log('✅ Ticket tracked successfully', {
                channelId: channel.id,
                ticketData
            });

        } catch (error) {
            this.logError('Failed to handle channel creation', error, {
                channelId: channel.id,
                channelName: channel.name
            });
        } finally {
            timer.end();
        }
    }

    /**
     * Wait for the first message in a channel with enhanced logging
     */
    async waitForFirstMessage(channel, timeout = 10000) {
        const timer = this.startTimer('waitForFirstMessage');
        
        return new Promise((resolve) => {
            this.debug('Waiting for first message', { channelId: channel.id, timeout });
            
            const timeoutTimer = setTimeout(() => {
                this.log('⏰ Timeout waiting for first message', {
                    channelId: channel.id,
                    timeoutMs: timeout
                });
                resolve(null);
            }, timeout);

            const messageHandler = (message) => {
                if (message.channel.id === channel.id) {
                    this.debug('First message received', {
                        channelId: channel.id,
                        messageId: message.id,
                        authorId: message.author.id
                    });
                    
                    clearTimeout(timeoutTimer);
                    this.client.off('messageCreate', messageHandler);
                    timer.end();
                    resolve(message);
                }
            };

            this.client.on('messageCreate', messageHandler);
        });
    }

    /**
     * Extract user tag from message content or author
     */
    extractUserTag(message) {
        this.debug('Extracting user tag', {
            messageId: message.id,
            mentionsCount: message.mentions.users.size,
            authorId: message.author.id
        });

        // Look for @mentions in the message
        const mentions = message.mentions.users;
        if (mentions.size > 0) {
            const user = mentions.first();
            const tag = `<@${user.id}>`;
            this.debug('User tag extracted from mentions', { tag, userId: user.id });
            return tag;
        }

        // If no mentions, use the message author
        const tag = `<@${message.author.id}>`;
        this.debug('User tag extracted from author', { tag, userId: message.author.id });
        return tag;
    }

    /**
     * Handle user messages in active tickets with enhanced validation logging
     */
    async handleUserMessage(message) {
        const timer = this.startTimer('handleUserMessage');
        
        try {
            // Skip bot messages
            if (message.author.bot) {
                this.debug('Skipping bot message', {
                    messageId: message.id,
                    authorId: message.author.id
                });
                return;
            }

            const ticket = this.activeTickets.get(message.channel.id);
            if (!ticket) {
                this.debug('Message in non-tracked channel', {
                    channelId: message.channel.id,
                    messageId: message.id
                });
                return;
            }

            if (!ticket.awaitingResponse) {
                this.debug('Ticket not awaiting response', {
                    channelId: message.channel.id,
                    messageId: message.id,
                    ticketState: ticket
                });
                return;
            }

            this.log('📨 Processing user message in active ticket', {
                channelId: message.channel.id,
                messageId: message.id,
                authorId: message.author.id,
                contentLength: message.content.length,
                attachmentsCount: message.attachments.size
            });

            let hasNewEvmAddress = false;
            let hasNewImage = false;

            // Check for EVM address (enhanced validation with logging)
            const evmAddressRegex = /0x[a-fA-F0-9]{40}/g;
            const evmMatches = message.content.match(evmAddressRegex);
            
            if (evmMatches && evmMatches.length > 0) {
                hasNewEvmAddress = true;
                this.log('💰 EVM address detected in message', {
                    channelId: message.channel.id,
                    messageId: message.id,
                    addresses: evmMatches,
                    previouslyHadAddress: ticket.hasEvmAddress
                });
                ticket.hasEvmAddress = true;
            } else {
                this.debug('No EVM address found in message content', {
                    channelId: message.channel.id,
                    messageId: message.id,
                    content: message.content.substring(0, 100) + '...'
                });
            }

            // Check for image attachments (enhanced validation with logging)
            if (message.attachments.size > 0) {
                const imageAttachments = [];
                message.attachments.forEach(attachment => {
                    this.debug('Checking attachment', {
                        channelId: message.channel.id,
                        attachmentId: attachment.id,
                        name: attachment.name,
                        contentType: attachment.contentType,
                        size: attachment.size
                    });
                    
                    if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                        imageAttachments.push({
                            id: attachment.id,
                            name: attachment.name,
                            contentType: attachment.contentType
                        });
                        hasNewImage = true;
                    }
                });

                if (hasNewImage) {
                    this.log('🖼️ Image attachments detected', {
                        channelId: message.channel.id,
                        messageId: message.id,
                        imageAttachments,
                        previouslyHadImage: ticket.hasImage
                    });
                    ticket.hasImage = true;
                }
            }

            // Log current ticket requirements status
            this.log('📋 Ticket requirements check', {
                channelId: message.channel.id,
                hasEvmAddress: ticket.hasEvmAddress,
                hasImage: ticket.hasImage,
                bothRequirementsMet: ticket.hasEvmAddress && ticket.hasImage
            });

            // If both requirements are met, send the form message
            if (ticket.hasEvmAddress && ticket.hasImage) {
                this.log('✅ All requirements met, sending form message', {
                    channelId: message.channel.id
                });
                
                const formMessage = await message.channel.send(messages.FORM_MESSAGE);
                
                this.log('📤 Form message sent successfully', {
                    channelId: message.channel.id,
                    formMessageId: formMessage.id
                });
                
                ticket.awaitingResponse = false;
                ticket.completedAt = new Date();
                ticket.formMessageId = formMessage.id;
                this.stats.ticketsCompleted++;
                
                // Schedule automatic closure with detailed logging
                const closeTimeoutMs = this.CLOSE_HOURS * 60 * 60 * 1000;
                const closeTime = new Date(Date.now() + closeTimeoutMs);
                
                this.log('⏰ Scheduling automatic ticket closure', {
                    channelId: message.channel.id,
                    closeInMs: closeTimeoutMs,
                    closeInHours: this.CLOSE_HOURS,
                    scheduledCloseTime: closeTime.toISOString()
                });
                
                setTimeout(() => {
                    this.log('🔄 Executing scheduled ticket closure', {
                        channelId: message.channel.id,
                        scheduledTime: closeTime.toISOString(),
                        actualTime: new Date().toISOString()
                    });
                    this.closeTicket(message.channel.id);
                }, closeTimeoutMs);
            } else {
                this.debug('Requirements not yet met, waiting for more messages', {
                    channelId: message.channel.id,
                    missingEvmAddress: !ticket.hasEvmAddress,
                    missingImage: !ticket.hasImage
                });
            }

        } catch (error) {
            this.logError('Failed to handle user message', error, {
                messageId: message.id,
                channelId: message.channel.id,
                authorId: message.author?.id
            });
        } finally {
            timer.end();
        }
    }

    /**
     * Close ticket by executing /close slash command
     */
      async closeTicket(channelId) {
        const timer = this.startTimer('closeTicket');
        try {
            this.log('🔒 Starting ticket closure process by sending $close command', { channelId });

            let channel = this.client.channels.cache.get(channelId);
            if (!channel) {
                this.log('⚠️ Channel not found in cache, attempting to fetch', { channelId });
                try {
                    channel = await this.client.channels.fetch(channelId);
                    if (!channel) {
                        this.log('❌ Channel not found even after fetch', { channelId });
                        return;
                    }
                } catch (fetchError) {
                    this.logError('Failed to fetch channel', fetchError, { channelId });
                    return;
                }
            }
            
            // Send $close command as a message
            await channel.send('$close');
            this.log('✅ $close command sent successfully', { channelId });

            // Update statistics and tracking
            this.activeTickets.delete(channelId);
            this.pendingClosures.set(channelId, {
                closedAt: new Date(),
                method: 'message_command',
                command: '$close'
            });
            this.stats.ticketsClosed++;
        } catch (error) {
            this.logError('Failed to close ticket', error, { channelId });
        } finally {
            timer.end();
        }
    }

    /**
     * Execute /close slash command properly using Discord API
     */
    async executeCloseCommand(channel) {
        try {
            this.log('💬 Executing /close slash command via Discord API', {
                channelId: channel.id,
                channelName: channel.name
            });

            const guild = channel.guild;
            if (!guild) {
                this.log('❌ No guild found for channel', { channelId: channel.id });
                return false;
            }

            // Method 1: Get all application commands available in the guild
            try {
                this.log('🔍 Fetching available application commands', {
                    guildId: guild.id,
                    channelId: channel.id
                });

                // Fetch both global and guild-specific commands
                const globalCommands = await this.client.application.commands.fetch();
                const guildCommands = await guild.commands.fetch();
                
                const allCommands = new Map([...globalCommands, ...guildCommands]);
                
                this.log('📋 Available commands found', {
                    globalCommandsCount: globalCommands.size,
                    guildCommandsCount: guildCommands.size,
                    totalCommands: allCommands.size,
                    commands: Array.from(allCommands.values()).map(cmd => ({
                        id: cmd.id,
                        name: cmd.name,
                        applicationId: cmd.applicationId,
                        type: cmd.type
                    }))
                });

                // Look for close command
                const closeCommand = Array.from(allCommands.values()).find(cmd => 
                    cmd.name.toLowerCase() === 'close' || 
                    cmd.name.toLowerCase().includes('close')
                );

                if (closeCommand) {
                    this.log('🎯 Found close command, creating interaction', {
                        channelId: channel.id,
                        commandId: closeCommand.id,
                        commandName: closeCommand.name,
                        applicationId: closeCommand.applicationId
                    });

                    // Create a proper interaction object that mimics a user slash command
                    const mockInteraction = {
                        type: 2, // APPLICATION_COMMAND
                        data: {
                            id: closeCommand.id,
                            name: closeCommand.name,
                            type: closeCommand.type || 1
                        },
                        channel_id: channel.id,
                        guild_id: guild.id,
                        member: {
                            user: this.client.user
                        },
                        user: this.client.user,
                        token: 'mock_token_' + Date.now(),
                        id: 'mock_interaction_' + Date.now(),
                        application_id: this.client.application.id
                    };

                    // Method 1a: Try to emit interactionCreate event
                    try {
                        this.log('📡 Emitting interactionCreate event', {
                            channelId: channel.id,
                            commandId: closeCommand.id
                        });

                        // Create a more complete mock interaction for the event
                        const eventInteraction = {
                            type: 2,
                            data: {
                                id: closeCommand.id,
                                name: closeCommand.name,
                                type: closeCommand.type || 1,
                                options: []
                            },
                            channel: channel,
                            guild: guild,
                            user: this.client.user,
                            member: guild.members.cache.get(this.client.user.id),
                            id: 'mock_' + Date.now(),
                            token: 'mock_token',
                            applicationId: this.client.application.id,
                            commandId: closeCommand.id,
                            commandName: closeCommand.name,
                            isCommand: () => true,
                            isButton: () => false,
                            isSelectMenu: () => false,
                            reply: async (options) => {
                                this.log('📨 Mock slash command reply', { options });
                                return channel.send(typeof options === 'string' ? options : options.content || 'Command executed');
                            },
                            deferReply: async () => {
                                this.log('⏳ Mock slash command defer reply');
                            },
                            editReply: async (options) => {
                                this.log('📝 Mock slash command edit reply', { options });
                                return channel.send(typeof options === 'string' ? options : options.content || 'Command completed');
                            }
                        };

                        // Emit the interaction event
                        this.client.emit('interactionCreate', eventInteraction);
                        
                        this.log('✅ InteractionCreate event emitted', {
                            channelId: channel.id,
                            commandName: closeCommand.name
                        });

                        // Wait a moment for the command to be processed
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        return true;

                    } catch (eventError) {
                        this.logError('Failed to emit interactionCreate event', eventError, {
                            channelId: channel.id,
                            commandId: closeCommand.id
                        });
                    }

                    // Method 1b: Try using REST API directly
                    try {
                        this.log('🌐 Attempting REST API interaction creation', {
                            channelId: channel.id,
                            commandId: closeCommand.id
                        });

                        const interactionData = {
                            type: 2,
                            application_id: closeCommand.applicationId,
                            guild_id: guild.id,
                            channel_id: channel.id,
                            session_id: 'automated_session_' + Date.now(),
                            data: {
                                version: closeCommand.version || '1',
                                id: closeCommand.id,
                                name: closeCommand.name,
                                type: closeCommand.type || 1,
                                options: []
                            },
                            nonce: Date.now().toString()
                        };

                        // Note: This is a theoretical approach - Discord doesn't officially allow bots to create interactions for other applications
                        this.log('⚠️ REST API interaction creation not officially supported', {
                            channelId: channel.id,
                            reason: 'Discord API limitations for cross-application interactions'
                        });

                    } catch (restError) {
                        this.logError('REST API interaction creation failed', restError, {
                            channelId: channel.id,
                            commandId: closeCommand.id
                        });
                    }

                } else {
                    this.log('❌ No close command found', {
                        channelId: channel.id,
                        availableCommands: Array.from(allCommands.values()).map(cmd => cmd.name)
                    });
                }

            } catch (commandFetchError) {
                this.logError('Failed to fetch application commands', commandFetchError, {
                    channelId: channel.id,
                    guildId: guild.id
                });
            }

            // Method 2: Fallback - Try to trigger the command by mentioning it
            try {
                this.log('🔄 Attempting command trigger via mention', {
                    channelId: channel.id
                });

                await channel.send('🤖 **Auto-Close**: Attempting to close this ticket. If you have a `/close` command, please use it now.');
                
                // Wait a moment and then send a more direct message
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                await channel.send('</close:0> - Automated closure request');
                
                this.log('📤 Command trigger messages sent', {
                    channelId: channel.id
                });

                return true;

            } catch (mentionError) {
                this.logError('Failed to send command trigger messages', mentionError, {
                    channelId: channel.id
                });
            }

            return false;

        } catch (error) {
            this.logError('Failed to execute close command', error, {
                channelId: channel.id
            });
            return false;
        }
    }

    /**
     * Fallback method to close ticket when slash command fails
     */
    async fallbackCloseTicket(channelId, channel) {
        try {
            this.log('🔄 Executing fallback ticket closure', { channelId });

            // Send a clear message about what should happen
            try {
                await channel.send([
                    '🤖 **Automated Ticket Closure**',
                    '',
                    'This ticket has completed processing and should now be closed.',
                    '',
                    '**Please:**',
                    '• Use the `/close` slash command if available',
                    '• Or click any "Close Ticket" button in this channel',
                    '• This ticket contained all required information and has been processed',
                    '',
                    '_This is an automated message._'
                ].join('\n'));
                
                this.log('📤 Detailed fallback closure message sent', { channelId });
            } catch (sendError) {
                this.logError('Failed to send fallback closure message', sendError, { channelId });
            }

            // Clean up our tracking
            this.log('🧹 Cleaning up ticket tracking', { channelId });
            this.activeTickets.delete(channelId);

        } catch (error) {
            this.logError('Fallback closure method failed completely', error, { channelId });
        }
    }

    /**
     * Get comprehensive ticket statistics
     */
    getStats() {
        const uptime = Date.now() - this.stats.startTime.getTime();
        return {
            ...this.stats,
            activeTickets: this.activeTickets.size,
            pendingClosures: this.pendingClosures.size,
            uptimeMs: uptime,
            uptimeHours: Math.floor(uptime / 1000 / 60 / 60),
            configuration: {
                ticketCategory: this.TICKET_CATEGORY,
                closeHours: this.CLOSE_HOURS,
                debugMode: this.DEBUG_MODE
            }
        };
    }

    /**
     * Get detailed information about active tickets
     */
    getActiveTicketsInfo() {
        const tickets = [];
        this.activeTickets.forEach((ticket, channelId) => {
            tickets.push({
                channelId,
                ...ticket,
                ageMs: Date.now() - ticket.createdAt.getTime(),
                ageMinutes: Math.floor((Date.now() - ticket.createdAt.getTime()) / 1000 / 60)
            });
        });
        return tickets;
    }
}

module.exports = TicketSender;