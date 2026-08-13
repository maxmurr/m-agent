import { createTool } from '@mastra/core/tools'
import type { ChannelContext } from '@mastra/core/channels'
import { z } from 'zod'

export const whoamiTool = createTool({
  id: 'whoami',
  description: 'Return the Slack identity of the current user',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const channel = context?.requestContext?.get('channel') as ChannelContext | undefined

    return {
      platform: channel?.platform,
      userId: channel?.userId,
      userName: channel?.userName,
      isDM: channel?.isDM,
    }
  },
})