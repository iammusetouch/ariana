import React from 'react';
import RunButton from './RunButton';

interface CodeBlockWithRunButtonProps {
    code: string;
    language?: string;
    onRun: () => void;
    disabled?: boolean;
    buttonText?: string;
    className?: string;
}

const CodeBlockWithRunButton: React.FC<CodeBlockWithRunButtonProps> = ({
    code,
    language = 'bash',
    onRun,
    disabled = false,
    buttonText = 'Run in Terminal',
    className
}) => {
    return (
        <div className="group bg-[var(--bg-1)] rounded-xl overflow-hidden p-1">
            <div className="relative">
                <div className="px-2 py-1 font-mono text-[var(--fg-1)]">
                    {code}
                </div>
                <button 
                    className="group-hover:block text-sm hidden absolute top-0 right-0 px-2 h-full bg-[var(--accent)] text-[var(--fg-3)] rounded-md hover:opacity-100 opacity-50 transition-colors cursor-pointer"
                    onClick={onRun}
                    disabled={disabled}
                >
                    {'→'} {buttonText}
                </button>
            </div>
        </div>
    );
};

export default CodeBlockWithRunButton;
