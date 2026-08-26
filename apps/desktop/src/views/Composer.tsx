/**
 * The two things you can type into, sharing one box.
 *
 * `DispatchComposer` sits under the master thread and starts a run — typing at
 * the thread is how a run comes into existence, so the thread's composer is
 * the dispatch composer rather than a message that would have nowhere to go.
 * `MessageComposer` sits under a run and steers it.
 *
 * They differ only in what the button does and what the footer has room for,
 * which is why the growing textarea, the ⌘⏎ handling and the attachment tray
 * live in one place.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import type { SessionRecord } from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import {
  MAX_ATTACHMENTS,
  attachmentInput,
  imageFiles,
  transferHasFiles,
  uploadImage,
  type Attachment,
  type ImageFile,
} from "../attachments.js";
import { NEW_SESSION_DRAFT, useDraft } from "../drafts.js";
import { ModelSelector, loadChoice, type ModelChoice } from "../model-selector.js";
import { compact } from "./ThreadRail.js";
import { BlobImage } from "./BlobImage.js";
import { SendIcon, StatusGlyph } from "../ui.js";

/** An upload still in flight, drawn from the local file rather than the store. */
interface Pending {
  id: number;
  /** Object URL for the local file; null where the platform has none. */
  preview: string | null;
}

let pendingSeq = 0;

function previewUrl(file: ImageFile): string | null {
  try {
    return URL.createObjectURL(file as unknown as Blob);
  } catch {
    // Not a real Blob (a test double), or no URL support. The chip just draws
    // its label until the upload lands.
    return null;
  }
}

/**
 * Images being attached to one composer.
 *
 * The uploads write into the draft store rather than into component state,
 * because a composer is unmounted the moment you click another run and an
 * upload started a second earlier still has to land somewhere. Only the
 * in-flight placeholders are local — they are the one thing that genuinely
 * dies with the view.
 */
function useAttachments(
  draftKey: string,
  onError: (message: string) => void,
): {
  pending: Pending[];
  take(files: ImageFile[]): void;
  remove(blobId: string): void;
} {
  const { api, drafts } = useHarness();
  const [pending, setPending] = useState<Pending[]>([]);
  // Read for the room calculation, which must not see a stale count when two
  // pastes land in the same tick.
  const inFlight = useRef(0);

  useEffect(() => {
    return () => {
      inFlight.current = 0;
    };
  }, [draftKey]);

  const take = useCallback(
    (files: ImageFile[]) => {
      if (files.length === 0) return;
      const held = drafts.get(draftKey).attachments.length + inFlight.current;
      const room = Math.max(0, MAX_ATTACHMENTS - held);
      if (room === 0) {
        onError(`a message carries at most ${MAX_ATTACHMENTS} images`);
        return;
      }
      if (files.length > room) {
        onError(
          `only ${room} more image${room === 1 ? "" : "s"} fit on this message; the rest were skipped`,
        );
      }
      for (const file of files.slice(0, room)) {
        const id = (pendingSeq += 1);
        const preview = previewUrl(file);
        inFlight.current += 1;
        setPending((current) => [
          ...current,
          { id, preview },
        ]);
        uploadImage(api, file)
          .then((attachment) => drafts.attach(draftKey, attachment))
          .catch((e: unknown) =>
            onError(e instanceof Error ? e.message : String(e)),
          )
          .finally(() => {
            inFlight.current = Math.max(0, inFlight.current - 1);
            setPending((current) => current.filter((p) => p.id !== id));
            if (preview !== null) URL.revokeObjectURL(preview);
          });
      }
    },
    [api, drafts, draftKey, onError],
  );

  const remove = useCallback(
    (blobId: string) => drafts.detach(draftKey, blobId),
    [drafts, draftKey],
  );

  return { pending, take, remove };
}

function AttachmentTray(props: {
  attachments: Attachment[];
  pending: Pending[];
  onRemove(blobId: string): void;
}): ReactNode {
  if (props.attachments.length === 0 && props.pending.length === 0) return null;
  return (
    <div className="composer-attachments">
      {props.attachments.map((attachment) => (
        <figure className="attach-chip" key={attachment.blobId}>
          <BlobImage
            className="attach-thumb"
            blobId={attachment.blobId}
            alt="attached image"
            {...(attachment.width !== undefined ? { width: attachment.width } : {})}
            {...(attachment.height !== undefined ? { height: attachment.height } : {})}
            // Bytes that are gone cannot be sent; retire the chip rather than
            // let the send fail on something the composer could already see.
            onMissing={() => props.onRemove(attachment.blobId)}
          />
          <button
            type="button"
            className="attach-remove"
            aria-label="remove attached image"
            title="remove image"
            onClick={() => props.onRemove(attachment.blobId)}
          >
            ×
          </button>
        </figure>
      ))}
      {props.pending.map((item) => (
        <figure className="attach-chip attach-chip-pending" key={item.id}>
          {item.preview !== null ? (
            <img className="attach-thumb" src={item.preview} alt="image being attached" />
          ) : (
            <span className="attach-thumb blob-image-pending" aria-hidden="true" />
          )}
          <figcaption>attaching…</figcaption>
        </figure>
      ))}
    </div>
  );
}

function Box(props: {
  value: string;
  placeholder: string;
  disabled: boolean;
  autoFocus: boolean;
  attachments: Attachment[];
  pending: Pending[];
  onChange(value: string): void;
  onFiles(files: ImageFile[]): void;
  onRemove(blobId: string): void;
  onSubmit(): void;
  footer: ReactNode;
}): ReactNode {
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (box === null || !props.autoFocus) return;
    box.focus();
    // A restored draft is text you were in the middle of: carry on at the end
    // of it rather than in front of it.
    box.setSelectionRange(box.value.length, box.value.length);
    // Only on mount: refocusing on every keystroke would fight the caret.
  }, [props.autoFocus]);

  // Grow with content up to the CSS max-height, then scroll.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    box.style.height = "auto";
    const max = Number.parseFloat(getComputedStyle(box).maxHeight);
    const wanted = box.scrollHeight;
    box.style.height = `${Number.isFinite(max) ? Math.min(wanted, max) : wanted}px`;
    // Only show a scroller once the field has actually stopped growing.
    box.style.overflowY = Number.isFinite(max) && wanted > max ? "auto" : "hidden";
  }, [props.value]);

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    const files = imageFiles(event.dataTransfer);
    setDragging(false);
    if (files.length === 0) return;
    // Only swallow the drop once there is an image in it: a dragged file of
    // some other kind should still reach whatever else would have handled it.
    event.preventDefault();
    props.onFiles(files);
  };

  return (
    <div
      className={`composer${dragging ? " composer-dropping" : ""}`}
      onDragOver={(event) => {
        if (!transferHasFiles(event.dataTransfer)) return;
        // Without this the browser navigates to the dropped file.
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        // Crossing into a child fires dragleave on the parent; only a pointer
        // that has actually left the composer should clear the highlight.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="composer-field">
        <AttachmentTray
          attachments={props.attachments}
          pending={props.pending}
          onRemove={props.onRemove}
        />
        <textarea
          ref={boxRef}
          rows={1}
          value={props.value}
          placeholder={props.placeholder}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData);
            // A paste with no image in it is a plain paste: let the textarea
            // have it, or pasting text would stop working.
            if (files.length === 0) return;
            e.preventDefault();
            props.onFiles(files);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              props.onSubmit();
            }
          }}
        />
        <div className="composer-row">
          <button
            type="button"
            className="btn btn-quiet composer-attach"
            title="attach an image, or paste or drop one"
            aria-label="attach an image"
            onClick={() => fileRef.current?.click()}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M9.5 3.5 5 8a2.5 2.5 0 0 0 3.5 3.5l4-4a4 4 0 0 0-5.6-5.6L2.8 6.1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              props.onFiles(imageFiles(e.target));
              // Same file twice in a row is otherwise not a change event.
              e.target.value = "";
            }}
          />
          {props.footer}
        </div>
      </div>
    </div>
  );
}

/** Starts a run. The master thread's composer. */
export function DispatchComposer(props: {
  autoFocus: boolean;
  onError(message: string): void;
}): ReactNode {
  const { api, select, drafts } = useHarness();
  // The draft outlives this view, which disappears the moment a run is
  // clicked; the text is still here when you come back.
  const [draft, setDraft] = useDraft(drafts, NEW_SESSION_DRAFT);
  const [choice, setChoice] = useState<ModelChoice>(loadChoice);
  const [busy, setBusy] = useState(false);
  const onError = props.onError;
  const { pending, take, remove } = useAttachments(NEW_SESSION_DRAFT, onError);

  const dispatch = useCallback(() => {
    const trimmed = draft.text.trim();
    // A task, unlike a message, has to say something: it is the instruction
    // and it is what the session is named after.
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    api
      .dispatch({
        task: trimmed,
        driver: choice.driver,
        ...(choice.modelId !== null ? { modelId: choice.modelId } : {}),
        ...(draft.attachments.length > 0
          ? { attachments: draft.attachments.map(attachmentInput) }
          : {}),
      })
      .then((record) => {
        // Only once the task is safely a session; a failed dispatch keeps it.
        drafts.clear(NEW_SESSION_DRAFT);
        select(record.id as string);
      })
      .catch((e: unknown) =>
        onError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  }, [api, draft, choice, busy, select, drafts, onError]);

  return (
    <Box
      value={draft.text}
      placeholder="Describe a task"
      disabled={false}
      autoFocus={props.autoFocus}
      attachments={draft.attachments}
      pending={pending}
      onChange={(text) => setDraft({ ...draft, text })}
      onFiles={take}
      onRemove={remove}
      onSubmit={dispatch}
      footer={
        <>
          <ModelSelector value={choice} onChange={setChoice} disabled={busy} />
          <span className="composer-spacer" />
          <span className="composer-hint">
            <kbd>⌘</kbd> <kbd>return</kbd>
          </span>
          <SendButton
            busy={busy}
            disabled={draft.text.trim().length === 0}
            label="Dispatch"
            busyLabel="Dispatching"
            onClick={dispatch}
          />
        </>
      }
    />
  );
}

/**
 * The composer's action, as a mark rather than a word.
 *
 * The verb it used to print is the one thing about this button nobody has to
 * be told: it sits at the end of the box you just typed into, with the ⌘⏎ hint
 * beside it. What the word was carrying is the *distinction* — dispatching
 * starts a run, sending steers one — and that survives in the accessible name
 * and the tooltip, where it is available on demand instead of taking a third
 * of the footer to say something the placeholder already said.
 *
 * In flight it wears the running meter, the same glyph a live run wears
 * everywhere else in the window, rather than a spinner this app does not
 * otherwise own.
 */
export function SendButton(props: {
  busy: boolean;
  disabled: boolean;
  label: string;
  busyLabel: string;
  onClick(): void;
}): ReactNode {
  return (
    <button
      type="button"
      className="btn btn-primary btn-icon composer-send"
      disabled={props.busy || props.disabled}
      aria-label={props.busy ? `${props.busyLabel}…` : props.label}
      aria-busy={props.busy}
      title={props.busy ? `${props.busyLabel}…` : `${props.label} (⌘⏎)`}
      onClick={props.onClick}
    >
      {props.busy ? <StatusGlyph status="running" /> : <SendIcon />}
    </button>
  );
}

/** Steers a run that already exists. */
export function MessageComposer(props: {
  session: SessionRecord | null;
  id: string;
  onError(message: string): void;
}): ReactNode {
  const { api, drafts } = useHarness();
  // The panel is keyed by session id, so this composer is thrown away and
  // rebuilt on every switch. The draft is what makes that survivable.
  const [draft, setDraft] = useDraft(drafts, props.id);
  const [busy, setBusy] = useState(false);
  const running = props.session?.status === "running";
  const onError = props.onError;
  const { pending, take, remove } = useAttachments(props.id, onError);

  // A screenshot with no caption is a message; an empty box with nothing
  // attached is not.
  const sendable = draft.text.trim().length > 0 || draft.attachments.length > 0;

  const send = useCallback(() => {
    if (!sendable || busy) return;
    setBusy(true);
    const id = props.id;
    api
      .message(
        id,
        draft.text.trim(),
        draft.attachments.map(attachmentInput),
      )
      // Only once the server has it; a failed send keeps the text.
      .then(() => drafts.clear(id))
      .catch((e: unknown) =>
        onError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  }, [api, draft, busy, sendable, props.id, drafts, onError]);

  const usage = props.session?.usage;
  const tokens = usage === undefined ? 0 : usage.tokensIn + usage.tokensOut;

  return (
    <Box
      value={draft.text}
      placeholder={
        running
          ? "Steer this run — it lands on the next turn…"
          : "Send a message to resume this run…"
      }
      disabled={false}
      autoFocus={false}
      attachments={draft.attachments}
      pending={pending}
      onChange={(text) => setDraft({ ...draft, text })}
      onFiles={take}
      onRemove={remove}
      onSubmit={send}
      footer={
        <>
          {usage !== undefined && tokens > 0 && (
            <span
              className="composer-facts"
              title={`${usage.tokensIn.toLocaleString()} in · ${usage.tokensOut.toLocaleString()} out`}
            >
              <span>{compact(tokens)} tokens</span>
              {usage.costUsd > 0 && <span>${usage.costUsd.toFixed(2)}</span>}
            </span>
          )}
          <span className="composer-spacer" />
          <span className="composer-hint">
            <kbd>⌘</kbd> <kbd>return</kbd>
          </span>
          <SendButton
            busy={busy}
            disabled={!sendable}
            label="Send"
            busyLabel="Sending"
            onClick={send}
          />
        </>
      }
    />
  );
}
