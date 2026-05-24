
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  INITIAL_MESSAGES,
  type MuralMessage,
} from "@/lib/mocks/messages";

// aperture-3d9t — MuralContext.
//
// In-memory message list. The Marketplace's mock checkout flow adds
// messages here on confirm (author "Você", note from the textarea).
// Messages component reads + renders the list. Composer card adds
// messages directly.
//
// Reload resets to INITIAL_MESSAGES (no persistence per constraint).

interface MuralContextValue {
  messages: MuralMessage[];
  addMessage: (data: Omit<MuralMessage, "id">) => void;
}

const MuralContext = createContext<MuralContextValue | null>(null);

let counter = 1000;
const nextId = () => `m-mock-${++counter}`;

export function MuralProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<MuralMessage[]>(INITIAL_MESSAGES);

  const addMessage = useCallback<MuralContextValue["addMessage"]>(
    (data) => {
      setMessages((prev) => [{ id: nextId(), ...data }, ...prev]);
    },
    [],
  );

  const value = useMemo(() => ({ messages, addMessage }), [messages, addMessage]);

  return (
    <MuralContext.Provider value={value}>{children}</MuralContext.Provider>
  );
}

export function useMural(): MuralContextValue {
  const ctx = useContext(MuralContext);
  if (!ctx) {
    throw new Error("useMural must be used within a MuralProvider");
  }
  return ctx;
}
