import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function NewTicket() {
    const navigate = useNavigate();
    const [formData, setFormData] = useState({ location: '', description: '' });
    const [file, setFile] = useState<File | null>(null);
    const [status, setStatus] = useState<'idle' | 'uploading' | 'submitting' | 'success' | 'error'>('idle');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        try {
            if (!file) {
                throw new Error('Please select a JPG, PNG, or WebP photo.');
            }
            if (file.size > 10 * 1024 * 1024) {
                throw new Error('Photo must be 10 MB or smaller.');
            }

            setStatus('uploading');

            // Send the image as a data URL; the backend checks its actual file signature.
            const imageUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    if (typeof reader.result === 'string') resolve(reader.result);
                    else reject(new Error('Could not read the selected photo.'));
                };
                reader.onerror = () => reject(new Error('Could not read the selected photo.'));
                reader.readAsDataURL(file);
            });

            setStatus('submitting');
            const apiBase = (
                (import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:8000'
            ).replace(/\/+$/, '');

            const ticketRes = await fetch(`${apiBase}/api/tickets/new`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    location: formData.location,
                    description: formData.description,
                    before_image_url: imageUrl
                })
            });

            if (!ticketRes.ok) {
                const result = await ticketRes.json().catch(() => null);
                throw new Error(result?.detail || `Failed to log anomaly (HTTP ${ticketRes.status}).`);
            }

            setStatus('success');
            setTimeout(() => navigate('/dashboard'), 1000);
        } catch (error) {
            console.error(error);
            setStatus('error');
            setTimeout(() => setStatus('idle'), 3000);
        }
    };

    return (
        <div className="max-w-2xl mx-auto mt-8 animate-fade-in">
            <div className="p-8 bg-white/5 backdrop-blur-md rounded-3xl border border-white/10 shadow-2xl relative overflow-hidden">
                {/* Decorative background glow */}
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-32 bg-cyan-500/20 blur-[100px] pointer-events-none"></div>

                <h2 className="text-3xl font-bold text-white mb-2 relative">Report Grid Anomaly</h2>
                <p className="text-gray-400 mb-8 relative">All uploads are scanned by the secure vault prior to storage.</p>

                <form onSubmit={handleSubmit} className="space-y-6 relative">

                    <div className="space-y-2">
                        <label className="text-sm font-mono text-cyan-400">SECTOR LOCATION</label>
                        <input
                            type="text"
                            required
                            minLength={2}
                            maxLength={150}
                            className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all placeholder:text-gray-600"
                            placeholder="e.g. North Conduit 4A"
                            value={formData.location}
                            onChange={e => setFormData({ ...formData, location: e.target.value })}
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-mono text-cyan-400">ANOMALY DESCRIPTION</label>
                        <textarea
                            required
                            minLength={5}
                            maxLength={1000}
                            rows={4}
                            className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all placeholder:text-gray-600 resize-none"
                            placeholder="Describe the structural failure or blockage..."
                            value={formData.description}
                            onChange={e => setFormData({ ...formData, description: e.target.value })}
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-mono text-cyan-400">EVIDENCE (JPG/PNG)</label>
                        <input
                            type="file"
                            accept="image/jpeg, image/png"
                            onChange={e => setFile(e.target.files?.[0] || null)}
                            className="w-full text-sm text-gray-400 file:mr-4 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-white/10 file:text-cyan-400 hover:file:bg-white/20 transition-all cursor-pointer"
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={status !== 'idle'}
                        className="w-full mt-8 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/50 font-bold py-4 rounded-xl transition-all hover:shadow-[0_0_20px_rgba(6,182,212,0.3)] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {status === 'idle' && 'INITIALIZE UPLOAD'}
                        {status === 'uploading' && 'VERIFYING MAGIC BYTES...'}
                        {status === 'submitting' && 'ENCRYPTING PAYLOAD...'}
                        {status === 'success' && 'LOGGED SUCCESSFULLY'}
                        {status === 'error' && 'TRANSMISSION FAILED'}
                    </button>
                </form>
            </div>
        </div>
    );
}