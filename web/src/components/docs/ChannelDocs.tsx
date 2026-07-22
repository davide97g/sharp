import { Navigate, useParams } from 'react-router-dom'
export function ChannelDocs() { const { channelId } = useParams<{ channelId: string }>(); return <Navigate to={channelId ? `/docs?channel=${channelId}` : '/docs'} replace /> }
