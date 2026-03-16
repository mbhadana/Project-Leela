import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Check, Mic, Keyboard, Sparkles, PenLine, Languages, Briefcase, Mail, AlignLeft, Loader2, Info
} from 'lucide-react';

export default function App() {
  const [text, setText] = useState(`hello hello hello one two three
i want send quick mesage but writing not good
pls fix grammar and make it sound better
also maybe make it little more professional`);
  const [isImproving, setIsImproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleImprove = useCallback(async () => {
    if (isImproving || !text.trim()) return;
    
    setIsImproving(true);
    setError(null);
    
    // Simulate logical AI processing for the demo
    await new Promise(r => setTimeout(r, 1500));
    
    const polishedVersion = `Hello, one, two, three.
I want to send a quick message, but my writing is not very good.
Please fix the grammar and improve the clarity.
You may also make the tone slightly more professional.`;
    
    setText(polishedVersion);
    setIsImproving(false);
  }, [text, isImproving]);

  // Auto-resize logic for textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [text]);

  const CommandCard = ({ title, shortcut, result }: { title: string, shortcut: React.ReactNode, result: string }) => (
    <div className="flex-1 bg-white border border-gray-100 p-5 rounded-2xl shadow-[0_4px_20px_rgb(0,0,0,0.02)] hover:shadow-[0_8px_30px_rgb(0,0,0,0.04)] transition-all duration-300">
      <h3 className="text-gray-800 font-semibold mb-2">{title}</h3>
      <div className="flex items-center gap-2 mb-3">
        {shortcut}
      </div>
      <p className="text-gray-500 text-sm leading-relaxed">{result}</p>
    </div>
  );

  const Kbd = ({ children }: { children: React.ReactNode }) => (
    <span className="font-mono bg-gray-50 border border-gray-200 px-2 py-1 rounded-md text-xs text-gray-600 shadow-sm inline-flex items-center justify-center min-w-[32px] font-bold">
      {children}
    </span>
  );

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col items-center justify-start font-sans py-12 px-6 md:px-12 selection:bg-emerald-100 selection:text-emerald-900">
      
      {/* 1. Command Guide Section */}
      <div className="w-full max-w-[1000px] grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <CommandCard 
          title="Command 1"
          shortcut={<><Kbd>Ctrl</Kbd><span className="text-gray-300">+</span><Kbd>Space</Kbd></>}
          result="Start speaking and Leela writes for you (when no text is selected)."
        />
        <CommandCard 
          title="Command 2"
          shortcut={<><span className="text-xs text-gray-400 font-medium italic">Select text</span><span className="text-gray-300">+</span><Kbd>Ctrl</Kbd><span className="text-gray-300">+</span><Kbd>Space</Kbd></>}
          result="Instantly improve grammar and clarity of selected text."
        />
        <CommandCard 
          title="Command 3"
          shortcut={<><span className="text-xs text-gray-400 font-medium italic">Select text</span><span className="text-gray-300">+</span><span className="text-xs text-gray-400 px-1">Hold</span><Kbd>Ctrl</Kbd><span className="text-gray-300">+</span><Kbd>Space</Kbd></>}
          result="Give voice instructions to modify the selected text as you wish."
        />
      </div>

      <div className="w-full max-w-[1000px] flex flex-col items-center">
        
        {/* 4. Instruction Hint */}
        <div className="mb-4 flex items-center gap-2 text-emerald-600 font-medium bg-emerald-50 px-4 py-2 rounded-full border border-emerald-100 text-sm animate-pulse">
          <Info className="w-4 h-4" />
          Try selecting the text and pressing Ctrl + Space.
        </div>

        {/* 2. Demo Text Area */}
        <div className="w-full bg-white rounded-[2rem] shadow-[0_10px_40px_rgb(0,0,0,0.04)] border border-gray-100 p-10 md:p-16 flex flex-col transition-all duration-300 hover:shadow-[0_20px_60px_rgb(0,0,0,0.06)]">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full text-2xl md:text-3xl font-medium text-gray-800 placeholder:text-gray-200 resize-none outline-none leading-[1.6] bg-transparent"
            spellCheck={false}
            rows={1}
          />
        </div>

        {/* 3. Single Action Button */}
        <div className="mt-12">
          <button
            onClick={handleImprove}
            disabled={isImproving || !text.trim()}
            className="flex items-center justify-center gap-3 px-10 py-5 bg-gray-900 hover:bg-gray-800 text-white rounded-full text-lg font-semibold transition-all shadow-xl hover:shadow-2xl hover:-translate-y-1 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed group"
          >
            {isImproving ? (
              <>
                <Loader2 className="w-6 h-6 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <Sparkles className="w-6 h-6 text-emerald-400 group-hover:scale-110 transition-transform" />
                Run Leela Demo
              </>
            )}
          </button>
        </div>

      </div>

      <footer className="mt-20 text-center text-gray-400">
        <p className="text-sm font-medium">Leela V1 • The Intelligent Writing Companion</p>
      </footer>

    </div>
  );
}
