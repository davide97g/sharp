import { Navigate, useParams } from 'react-router-dom'
export function ChannelCanvases() { const { channelId } = useParams<{ channelId: string }>(); return <Navigate to={channelId ? `/canvas?channel=${channelId}` : '/canvas'} replace /> }
