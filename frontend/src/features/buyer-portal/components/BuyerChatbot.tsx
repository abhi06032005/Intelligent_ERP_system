import { useState, useEffect, useRef } from 'react';
import {
  MessageSquare,
  Sparkles,
  X,
  RefreshCw,
  Mic,
  MicOff,
  Send,
  Package,
  Calendar,
  Activity,
  Bot,
  User,
  AlertCircle,
} from 'lucide-react';
import { useAuth } from '../../auth/Auth';
import { api } from '../../../services/api';
import './BuyerChatbot.css';

interface SanitizedOrderContext {
  orderNumber: string;
  fabric: string;
  color: string;
  totalQuantityMeters: number;
  producedQuantityMeters: number;
  approvedQuantityMeters: number;
  dispatchedQuantityMeters: number;
  remainingQuantityMeters: number;
  progressPercent: number;
  status: string;
  stage: string;
  deadline: string;
  priority: string;
  instructions: string;
  latestUpdate: string;
  isDelayed: boolean;
  statusExplanation: string;
}

// The browser's Web Speech API; not in every browser, so it is looked up at runtime.
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
}
type RecognitionCtor = new () => Recognition;

interface ChatMessage {
  id: string;
  sender: 'buyer' | 'assistant';
  text: string;
  timestamp: string;
  inputMode?: 'voice' | 'text';
}

const QUICK_PROMPTS = [
  'What are my active orders?',
  'Which of my orders are completed?',
  'How many meters of fabric are remaining?',
  'When are my orders scheduled for delivery?',
  'Has any fabric been dispatched yet?',
];

function cleanDisplayText(text: string): string {
  if (!text) return '';
  return text.replace(/\*\*/g, '').replace(/\*/g, '').trim();
}

export function BuyerChatbot() {
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentOrder, setCurrentOrder] = useState<SanitizedOrderContext | null>(null);
  const [activeOrders, setActiveOrders] = useState<SanitizedOrderContext[]>([]);
  const [selectedOrderIndex, setSelectedOrderIndex] = useState(0);
  const [hasActiveOrder, setHasActiveOrder] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<Recognition | null>(null);

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Clean up voice recognition on unmount
  useEffect(() => {
    return () => {
      stopListening();
    };
  }, []);

  // Load real active order from database when chatbot opens
  useEffect(() => {
    if (isOpen) {
      loadOrderDetails();
    }
  }, [isOpen, user.buyerId]);

  const stopListening = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Already stopped.
      }
      recognitionRef.current = null;
    }
    setIsListening(false);
  };

  const loadOrderDetails = async () => {
    try {
      setBannerError(null);
      // Calls main LoomOS backend /api/v1/buyer-chat/current-order backed by real PostgreSQL
      const data = await api<{
        hasActiveOrder: boolean;
        order: SanitizedOrderContext | null;
        activeOrders?: SanitizedOrderContext[];
        completedOrders?: SanitizedOrderContext[];
        buyerName: string;
      }>('/buyer-chat/current-order');

      const activeList = data.activeOrders || (data.order ? [data.order] : []);

      setActiveOrders(activeList);
      setCurrentOrder(activeList[0] || null);
      setHasActiveOrder(activeList.length > 0);

      const buyerName = data.buyerName || user.name || 'Valued Buyer';
      let greetingText = '';

      if (activeList.length === 0) {
        greetingText = `Hello ${buyerName}. I'm your LoomOS order assistant. You don't currently have active orders in production. Past completed orders are archived in your LoomOS workspace. How can I help you?`;
      } else if (activeList.length === 1) {
        const ord = activeList[0];
        const stageText = ord.status === 'PENDING_REVIEW' || ord.stage?.toLowerCase().includes('review')
          ? 'waiting for factory planning review'
          : `in the ${ord.stage} stage`;
        greetingText = `Hello ${buyerName}. I'm your LoomOS order assistant. Your active order ${ord.orderNumber} (${ord.fabric}) is currently ${stageText}. How can I assist you with your order?`;
      } else {
        const orderSummaryList = activeList.map((o) => `${o.orderNumber} (${o.fabric})`).join(', ');
        greetingText = `Hello ${buyerName}. I'm your LoomOS order assistant. You currently have ${activeList.length} active orders (${orderSummaryList}). How can I assist you with your orders?`;
      }

      const initialGreeting: ChatMessage = {
        id: 'msg-greeting',
        sender: 'assistant',
        text: greetingText,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      if (messages.length === 0) {
        setMessages([initialGreeting]);
      }
    } catch (err) {
      console.warn('Failed to load current order from backend:', err);
      setBannerError('Connecting to LoomOS factory order service...');
      if (messages.length === 0) {
        setMessages([
          {
            id: 'msg-greeting-offline',
            sender: 'assistant',
            text: `Hello ${user.name}. I'm your LoomOS order assistant. You can ask questions about your fabric production, remaining meters, or delivery timeline.`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
      }
    }
  };

  const handleSendMessage = async (textToSend?: string, mode: 'voice' | 'text' = 'text') => {
    const query = (textToSend || inputText).trim();
    if (!query || isLoading) return;

    const userMsg: ChatMessage = {
      id: `usr-${Date.now()}`,
      sender: 'buyer',
      text: query,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      inputMode: mode,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputText('');
    setIsLoading(true);
    setBannerError(null);

    try {
      // Calls main LoomOS backend /api/v1/buyer-chat/chat with Groq AI + key failover
      const data = await api<{
        answer: string;
        hasActiveOrder: boolean;
        buyerName: string;
        orderSummary: SanitizedOrderContext | null;
        activeOrders?: SanitizedOrderContext[];
        completedOrders?: SanitizedOrderContext[];
      }>('/buyer-chat/chat', {
        question: query,
        inputMode: mode,
      });

      const assistantMsg: ChatMessage = {
        id: `ast-${Date.now()}`,
        sender: 'assistant',
        text: cleanDisplayText(data.answer),
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [...prev, assistantMsg]);
      if (data.activeOrders && data.activeOrders.length > 0) {
        setActiveOrders(data.activeOrders);
        setCurrentOrder(data.activeOrders[selectedOrderIndex] || data.activeOrders[0]);
        setHasActiveOrder(true);
      } else if (data.orderSummary) {
        setCurrentOrder(data.orderSummary);
        setHasActiveOrder(data.hasActiveOrder);
      }
    } catch (err) {
      console.error('Chat error:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: `ast-err-${Date.now()}`,
          sender: 'assistant',
          text: `Error: ${err instanceof Error ? err.message : 'Failed to process inquiry. Please try again.'}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  // Voice speech recognition handler with robust browser support & microphone permissions
  const handleToggleVoice = async () => {
    if (isListening) {
      stopListening();
      return;
    }

    const w = window as Window & { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const SpeechRecognition = w.SpeechRecognition || w.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setBannerError('Voice input is not supported in this browser. Please use Google Chrome or Microsoft Edge, or type your query.');
      return;
    }

    // Ask for the microphone up front so the permission prompt is not hidden behind recognition errors.
    await navigator.mediaDevices?.getUserMedia({ audio: true }).catch(() => undefined);

    try {
      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.lang = navigator.language || 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
        setBannerError(null);
      };

      recognition.onresult = (event) => {
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = 0; i < event.results.length; ++i) {
          const res = event.results[i];
          if (res.isFinal) {
            finalTranscript += res[0].transcript;
          } else {
            interimTranscript += res[0].transcript;
          }
        }

        const spoken = (finalTranscript || interimTranscript).trim();
        if (spoken) {
          setInputText(spoken);
        }

        if (finalTranscript.trim().length > 1) {
          stopListening();
          handleSendMessage(finalTranscript.trim(), 'voice');
        }
      };

      recognition.onerror = (e) => {
        console.warn('Speech recognition event:', e.error);
        if (e.error === 'no-speech') {
          // Ignore no-speech silence
          return;
        }
        stopListening();
        if (e.error === 'not-allowed') {
          setBannerError('Microphone permission blocked. Please click the lock icon in your browser address bar and allow Microphone.');
        } else {
          setBannerError(`Microphone issue (${e.error}). You can type your question directly below.`);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
        recognitionRef.current = null;
      };

      recognition.start();
    } catch (err) {
      setIsListening(false);
      recognitionRef.current = null;
      setBannerError(`Failed to access microphone: ${err instanceof Error ? err.message : 'Please check mic permissions.'}`);
    }
  };

  return (
    <>
      {/* Floating Launcher Button */}
      <button
        id="loomos-buyer-chatbot-launcher"
        className="loomos-chat-launcher"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={isOpen ? 'Close Assistant' : 'Open Buyer Order Assistant'}
      >
        {!isOpen && <div className="loomos-launcher-ripple" />}
        {isOpen ? <X size={20} /> : <MessageSquare size={20} />}
        <span>{isOpen ? 'Close Assistant' : 'Order Assistant'}</span>
        {!isOpen && <Sparkles size={15} style={{ color: '#c8f135' }} />}
      </button>

      {/* Chat Popup Window */}
      {isOpen && (
        <div
          id="loomos-buyer-chatbot-popup"
          className="loomos-chat-popup"
          role="dialog"
          aria-label="Buyer Order Assistant"
        >
          {/* Header */}
          <div className="loomos-chat-header">
            <div className="loomos-header-left">
              <div className="loomos-bot-avatar">
                <Bot size={18} />
              </div>
              <div>
                <h3>Buyer Order Assistant</h3>
                <div className="loomos-header-sub">
                  <span className="loomos-online-dot" />
                  <span>{user.name || 'LoomOS ERP'}</span>
                </div>
              </div>
            </div>

            <div className="loomos-header-right">
              <button
                className="loomos-head-btn"
                onClick={loadOrderDetails}
                title="Refresh order"
                aria-label="Refresh order"
              >
                <RefreshCw size={14} />
              </button>
              <button
                className="loomos-head-btn"
                onClick={() => setIsOpen(false)}
                title="Close"
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>
          </div>

          {/* Active Order Preview Card */}
          <div className="loomos-chat-order-card">
            {hasActiveOrder && activeOrders.length > 0 ? (
              <>
                {activeOrders.length > 1 && (
                  <div className="loomos-order-tabs">
                    <span className="loomos-order-tabs-label">Active Orders ({activeOrders.length}):</span>
                    {activeOrders.map((ord, idx) => (
                      <button
                        key={ord.orderNumber}
                        type="button"
                        className={`loomos-order-tab-chip ${selectedOrderIndex === idx ? 'active' : ''}`}
                        onClick={() => {
                          setSelectedOrderIndex(idx);
                          setCurrentOrder(ord);
                        }}
                      >
                        {ord.orderNumber}
                      </button>
                    ))}
                  </div>
                )}
                {(() => {
                  const displayOrder = activeOrders[selectedOrderIndex] || currentOrder || activeOrders[0];
                  return (
                    <>
                      <div className="loomos-card-row-top">
                        <span className="loomos-order-code">
                          <Package size={13} style={{ color: '#111316' }} />
                          {displayOrder.orderNumber}
                        </span>
                        <span className="loomos-order-stage-badge">
                          {displayOrder.stage}
                        </span>
                      </div>
                      <div className="loomos-order-fabric">
                        {displayOrder.fabric} · <span>{displayOrder.color}</span>
                      </div>
                      <div className="loomos-progress-track">
                        <div
                          className="loomos-progress-bar"
                          style={{ width: `${displayOrder.progressPercent}%` }}
                        />
                      </div>
                      <div className="loomos-order-stats">
                        <span>
                          <Activity size={11} style={{ color: '#111316' }} />
                          {displayOrder.producedQuantityMeters.toLocaleString()}m / {displayOrder.totalQuantityMeters.toLocaleString()}m ({displayOrder.progressPercent}%)
                        </span>
                        <span>
                          <Calendar size={11} />
                          Due {displayOrder.deadline}
                        </span>
                      </div>
                    </>
                  );
                })()}
              </>
            ) : (
              <div className="loomos-card-empty">
                <span className="loomos-order-code">
                  <Package size={13} style={{ color: '#838b84' }} /> Active Orders
                </span>
                <p>No active orders currently in production. Completed orders are archived.</p>
              </div>
            )}
          </div>

          {/* Warning Banner */}
          {bannerError && (
            <div className="loomos-chat-banner">
              <AlertCircle size={14} />
              <span>{bannerError}</span>
            </div>
          )}

          {/* Chat Messages Area */}
          <div className="loomos-chat-messages">
            {messages.map((m) => (
              <div key={m.id} className={`loomos-msg-row ${m.sender}`}>
                <div className="loomos-msg-bubble">
                  {m.text}
                </div>
                <div className="loomos-msg-meta">
                  {m.sender === 'assistant' ? (
                    <>
                      <Bot size={11} style={{ color: '#111316' }} /> LoomOS AI · {m.timestamp}
                    </>
                  ) : (
                    <>
                      {m.inputMode === 'voice' && (
                        <Mic size={11} style={{ color: '#111316' }} />
                      )}
                      <User size={11} /> You · {m.timestamp}
                    </>
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="loomos-msg-row assistant">
                <div className="loomos-typing-bubble">
                  <span className="loomos-dot" />
                  <span className="loomos-dot" />
                  <span className="loomos-dot" />
                </div>
                <div className="loomos-msg-meta">
                  <Bot size={11} style={{ color: '#111316' }} /> Consulting factory database...
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Suggested Quick Prompts */}
          <div className="loomos-prompts-tray">
            {QUICK_PROMPTS.map((prompt, idx) => (
              <button
                key={idx}
                type="button"
                className="loomos-prompt-chip"
                onClick={() => handleSendMessage(prompt, 'text')}
                disabled={isLoading}
              >
                {prompt}
              </button>
            ))}
          </div>

          {/* Voice Listening Wave Indicator */}
          {isListening && (
            <div className="loomos-listening-bar">
              <span>Listening to your microphone... Speak now</span>
              <div className="loomos-wave-bar" />
              <div className="loomos-wave-bar" />
              <div className="loomos-wave-bar" />
              <div className="loomos-wave-bar" />
            </div>
          )}

          {/* Input Footer */}
          <div className="loomos-chat-footer">
            <form
              className="loomos-input-wrapper"
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
            >
              <button
                type="button"
                className={`loomos-mic-btn ${isListening ? 'listening' : ''}`}
                onClick={handleToggleVoice}
                title={isListening ? 'Stop listening' : 'Speak your query'}
                aria-label="Microphone"
              >
                {isListening ? <MicOff size={16} /> : <Mic size={16} />}
              </button>

              <input
                type="text"
                className="loomos-input-field"
                placeholder="Ask about your order or speak..."
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                disabled={isLoading}
              />

              <button
                type="submit"
                className="loomos-send-btn"
                disabled={!inputText.trim() || isLoading}
                title="Send"
                aria-label="Send"
              >
                <Send size={15} />
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
