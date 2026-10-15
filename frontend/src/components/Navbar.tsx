import { Link } from 'react-router-dom';

export default function Navbar() {
    return (
        <nav className="p-4 bg-white/5 backdrop-blur-md border-b border-white/10">
            <div className="container mx-auto flex justify-between items-center">
                <div className="flex items-center gap-3"><img src="/favicon.svg?v=logo26" alt="DrainGRID Logo" className="dg-brand-logo h-14 w-14 shrink-0 object-contain bg-transparent" /><h1 className="text-xl font-bold text-cyan-400 tracking-wider">DrainGRID</h1></div>
                <div className="space-x-6">
                    <Link to="/dashboard" className="text-gray-300 hover:text-cyan-400 transition-colors">Dashboard</Link>
                    <Link to="/new-ticket" className="text-gray-300 hover:text-cyan-400 transition-colors">New Ticket</Link>
                </div>
            </div>
        </nav>
    );
}