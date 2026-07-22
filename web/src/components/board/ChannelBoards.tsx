import { Navigate, useParams } from 'react-router-dom'
export function ChannelBoards() { const { channelId } = useParams<{ channelId: string }>(); return <Navigate to={channelId ? `/board?channel=${channelId}` : '/board'} replace /> }
