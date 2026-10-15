import { useEffect, useState } from 'react';

// Define the shape of our data based on the Python backend
interface Ticket {
    id: string;
    location: string;
    description: string;
    status: string;
    before_image_url: string;
}

export default function Dashboard() {
    const [tickets, setTickets] = useState<Ticket[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch((((import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:8000').replace(/\/+$/, '') + '/api/tickets'))
            .then(res => res.json())
            .then(data => {
                setTickets(data);
                setLoading(false);
            })
            .catch(err => {
                console.error("Backend connection failed:", err);
                setLoading(false);
            });
    }, []);

    return (
        <div className="space-y-8 animate-fade-in">
            <div className="flex justify-between items-end border-b border-white/10 pb-4">
                <div>
                    <h2 className="text-3xl font-bold text-white tracking-wide">Active Grid Sectors</h2>
                    <p className="text-cyan-400/70 mt-1">Live anomaly monitoring</p>
                </div>
                <div className="text-sm font-mono text-gray-500">
                    {tickets.length} Anomalies Logged
                </div>
            </div>

            {loading ? (
                <div className="flex items-center space-x-3 text-cyan-400 font-mono animate-pulse">
                    <div className="w-2 h-2 bg-cyan-400 rounded-full"></div>
                    <span>Syncing with secure backend...</span>
                </div>
            ) : tickets.length === 0 ? (
                <div className="p-12 bg-white/5 backdrop-blur-md rounded-2xl border border-white/10 text-gray-400 text-center font-mono">
                    No anomalies detected. Sector is secure.
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {tickets.map(ticket => (
                        <div
                            key={ticket.id}
                            className="p-6 bg-white/5 backdrop-blur-md rounded-2xl border border-white/10 shadow-lg transition-all duration-300 hover:-translate-y-2 hover:shadow-cyan-500/20 hover:border-cyan-500/40 relative group"
                        >
                            <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity rounded-2xl pointer-events-none"></div>

                            <div className="flex justify-between items-start mb-4 relative">
                                <h3 className="text-xl font-bold text-cyan-50">{ticket.location}</h3>
                                <span className="px-2 py-1 text-xs font-mono rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/30">
                                    {ticket.status}
                                </span>
                            </div>

                            <p className="text-gray-400 text-sm mb-6 leading-relaxed line-clamp-3">
                                {ticket.description}
                            </p>

                            <div className="flex justify-between items-center text-xs text-gray-500 font-mono border-t border-white/5 pt-4">
                                <span>ID: {ticket.id}</span>
                                {ticket.before_image_url && <span className="text-cyan-500/50">IMAGE_ATTACHED</span>}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}