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
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { ImagePart, JournalEvent, SessionRecord } from "@daydream-code/shared";
import type { AgentSkill } from "@daydream-code/driver";
import type { NextMessage } from "@daydream-code/session";
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
import { compact } from "../ui.js";
import { BlobImage } from "./BlobImage.js";
import { SendIcon, ShiftIcon, StatusGlyph, StopIcon } from "../ui.js";

/** An upload still in flight, drawn from the local file rather than the store. */
interface Pending {
  id: number;
  /** Object URL for the local file; null where the platform has none. */
  preview: string | null;
}

let pendingSeq = 0;

type SkillLoad =
  | { status: "idle" | "loading"; skills: AgentSkill[] }
  | { status: "ready"; skills: AgentSkill[] }
  | { status: "error"; skills: AgentSkill[] };

type StoredSkillLoad = SkillLoad & { driver: string };

const skillRequests = new WeakMap<
  object,
  Map<string, Promise<AgentSkill[]>>
>();

/** One request per provider and project connection, shared across composers. */
function cachedSkills(
  api: { skills(driver: string): Promise<AgentSkill[]> },
  driver: string,
): Promise<AgentSkill[]> {
  let requests = skillRequests.get(api);
  if (requests === undefined) {
    requests = new Map();
    skillRequests.set(api, requests);
  }
  const existing = requests.get(driver);
  if (existing !== undefined) return existing;
  const request = api.skills(driver).catch((error: unknown) => {
    requests?.delete(driver);
    throw error;
  });
  requests.set(driver, request);
  return request;
}

function useAgentSkills(driver: string): SkillLoad & { load(): void } {
  const { api } = useHarness();
  const currentDriver = useRef(driver);
  currentDriver.current = driver;
  const [stored, setStored] = useState<StoredSkillLoad>({
    driver,
    status: "idle",
    skills: [],
  });
  const result: SkillLoad =
    stored.driver === driver
      ? stored
      : { status: "idle", skills: [] };

  const load = useCallback(() => {
    if (driver.length === 0) {
      setStored({ driver, status: "error", skills: [] });
      return;
    }
    setStored((current) =>
      current.driver === driver && current.status === "ready"
        ? current
        : {
            driver,
            status: "loading",
            skills: current.driver === driver ? current.skills : [],
          },
    );
    cachedSkills(api, driver)
      .then((skills) => {
        if (currentDriver.current === driver) {
          setStored({ driver, status: "ready", skills });
        }
      })
      .catch(() => {
        if (currentDriver.current === driver) {
          setStored({ driver, status: "error", skills: [] });
        }
      });
  }, [api, driver]);

  return { ...result, load };
}

/** A skill menu exists only while the first, unfinished token is `/…`. */
export function leadingSkillQuery(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const query = value.slice(1);
  return /\s/.test(query) ? null : query.toLocaleLowerCase();
}

export function matchingSkills(
  skills: readonly AgentSkill[],
  query: string,
): AgentSkill[] {
  const needle = query.toLocaleLowerCase();
  return skills
    .map((skill, index) => {
      const name = skill.name.toLocaleLowerCase();
      const description = skill.description.toLocaleLowerCase();
      const rank = name.startsWith(needle)
        ? 0
        : name.includes(needle)
          ? 1
          : description.includes(needle)
            ? 2
            : 3;
      return { skill, index, rank };
    })
    .filter((item) => item.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.skill);
}

export function skillMenuKeyAction(
  key: string,
): "previous" | "next" | "choose" | "dismiss" | null {
  if (key === "ArrowUp") return "previous";
  if (key === "ArrowDown") return "next";
  if (key === "Enter" || key === "Tab") return "choose";
  if (key === "Escape") return "dismiss";
  return null;
}

/**
 * The menu exists only for an unfinished leading `/…` token, on a composer that
 * knows which provider to ask, and not for a value Escape already dismissed.
 * The driver check is load-bearing: a composer with no session used to fall
 * through to the request and render the failure as "couldn't load skills".
 */
export function skillMenuOpen(input: {
  value: string;
  driver: string;
  dismissed: string | null;
}): boolean {
  return (
    leadingSkillQuery(input.value) !== null &&
    input.dismissed !== input.value &&
    input.driver.length > 0
  );
}

export function skillInvocation(skill: AgentSkill): string {
  return `${skill.invocation}${skill.name} `;
}

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
  onDefer?(): void;
  onEditPrevious?(): void;
  onCancelEdit?(): void;
  skillDriver: string;
  leading?: ReactNode;
  footer: ReactNode;
}): ReactNode {
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dismissedValue, setDismissedValue] = useState<string | null>(null);
  const [activeSkill, setActiveSkill] = useState(0);
  const menuId = useId();
  const skillLoad = useAgentSkills(props.skillDriver);
  const query = leadingSkillQuery(props.value);
  const menuOpen = skillMenuOpen({
    value: props.value,
    driver: props.skillDriver,
    dismissed: dismissedValue,
  });
  const skills = useMemo(
    () => (query === null ? [] : matchingSkills(skillLoad.skills, query)),
    [query, skillLoad.skills],
  );
  const activeIndex =
    skills.length === 0 ? 0 : Math.min(activeSkill, skills.length - 1);
  /* Every skill in a load comes from one provider, so the first one's syntax
     speaks for all of them, including when the filter leaves none. */
  const invocationPrefix = skillLoad.skills[0]?.invocation ?? "/";

  useEffect(() => {
    if (menuOpen && skillLoad.status === "idle") skillLoad.load();
  }, [menuOpen, skillLoad.status, skillLoad.load]);

  useEffect(() => {
    setActiveSkill(0);
  }, [query, props.skillDriver]);

  useEffect(() => {
    if (!menuOpen || skills.length === 0) return;
    document
      .getElementById(`${menuId}-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, menuId, menuOpen, skills.length]);

  const chooseSkill = (skill: AgentSkill): void => {
    const next = skillInvocation(skill);
    setDismissedValue(next);
    props.onChange(next);
    requestAnimationFrame(() => boxRef.current?.focus());
  };

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
      {props.leading}
      <div className="composer-field">
        {menuOpen && (
          <div
            id={menuId}
            className="skill-menu glass-strong"
            role="listbox"
            aria-label={`Skills available to ${props.skillDriver}`}
          >
            <div className="skill-menu-head">
              <span>skills</span>
              {skillLoad.status === "ready" && (
                <span>
                  {skills.length === skillLoad.skills.length
                    ? skillLoad.skills.length
                    : `${skills.length} of ${skillLoad.skills.length}`}
                </span>
              )}
            </div>
            <div className="skill-menu-list">
              {skillLoad.status === "loading" && (
                <div className="skill-menu-loading">
                  <div className="skeleton" style={{ height: 12, width: "38%" }} />
                  <div
                    className="skeleton"
                    style={{ height: 12, width: "64%", opacity: 0.6 }}
                  />
                  <div
                    className="skeleton"
                    style={{ height: 12, width: "47%", opacity: 0.35 }}
                  />
                </div>
              )}
              {skillLoad.status === "error" && (
                <div className="skill-menu-state">
                  <span>couldn’t reach {props.skillDriver}</span>
                  <button
                    type="button"
                    className="btn"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => skillLoad.load()}
                  >
                    try again
                  </button>
                </div>
              )}
              {skillLoad.status === "ready" && skills.length === 0 && (
                <div className="skill-menu-state">
                  {query === "" ? (
                    <span>
                      {props.skillDriver} reports no skills. this list is the
                      provider’s own catalog.
                    </span>
                  ) : (
                    <span>no skill matches {invocationPrefix}{query}</span>
                  )}
                </div>
              )}
              {skills.map((skill, index) => (
                <button
                  id={`${menuId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className="skill-menu-item"
                  tabIndex={-1}
                  data-active={index === activeIndex}
                  key={skill.name}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveSkill(index)}
                  onClick={() => chooseSkill(skill)}
                >
                  <span className="skill-menu-name">
                    {skill.invocation}{skill.name}
                  </span>
                  <span className="skill-menu-description">
                    {skill.description}
                  </span>
                  {skill.argumentHint !== undefined && (
                    <span className="skill-menu-hint">{skill.argumentHint}</span>
                  )}
                </button>
              ))}
            </div>
            {skills.length > 0 && (
              <div className="skill-menu-foot">
                <span><kbd>↑</kbd><kbd>↓</kbd> choose</span>
                <span><kbd>return</kbd> insert</span>
                <span className="skill-menu-optional">
                  <kbd>esc</kbd> dismiss
                </span>
                {invocationPrefix === "$" && (
                  <span className="skill-menu-note">
                    {props.skillDriver} invokes with $, not /
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        <AttachmentTray
          attachments={props.attachments}
          pending={props.pending}
          onRemove={props.onRemove}
        />
        <textarea
          ref={boxRef}
          rows={1}
          value={props.value}
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          aria-activedescendant={
            menuOpen && skills.length > 0 ? `${menuId}-${activeIndex}` : undefined
          }
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
            if (menuOpen) {
              const menuAction = skillMenuKeyAction(e.key);
              if (menuAction !== null) {
                e.preventDefault();
                if (menuAction === "previous" && skills.length > 0) {
                  setActiveSkill((current) =>
                    (current - 1 + skills.length) % skills.length,
                  );
                } else if (menuAction === "next" && skills.length > 0) {
                  setActiveSkill((current) => (current + 1) % skills.length);
                } else if (menuAction === "choose" && skills.length > 0) {
                  chooseSkill(skills[activeIndex]!);
                } else if (menuAction === "dismiss") {
                  setDismissedValue(props.value);
                }
                return;
              }
            }
            const action = composerKeyAction(e, {
              canDefer: props.onDefer !== undefined,
              canEditPrevious:
                props.onEditPrevious !== undefined &&
                props.value.length === 0 &&
                props.attachments.length === 0 &&
                props.pending.length === 0,
              editing: props.onCancelEdit !== undefined,
            });
            if (action === null) return;
            e.preventDefault();
            if (action === "defer") props.onDefer?.();
            else if (action === "editPrevious") props.onEditPrevious?.();
            else if (action === "cancelEdit") props.onCancelEdit?.();
            else props.onSubmit();
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

export function composerKeyAction(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">,
  options: { canDefer: boolean; canEditPrevious: boolean; editing: boolean },
): "send" | "defer" | "editPrevious" | "cancelEdit" | null {
  if (event.key === "Escape" && options.editing) return "cancelEdit";
  if (event.key === "ArrowUp" && options.canEditPrevious) return "editPrevious";
  if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return null;
  if (options.editing) return "send";
  return event.shiftKey && options.canDefer ? "defer" : "send";
}

function nextPreview(next: NextMessage): string {
  const images = next.images.length;
  return [
    next.message.trim(),
    images > 0 ? `${images} image${images === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function NextMessageQueue(props: {
  messages: NextMessage[];
  busyId: string | null;
  onCancel(next: NextMessage): void;
  onCancelEdit(next: NextMessage): void;
}): ReactNode {
  if (props.messages.length === 0) return null;
  return (
    <div className="next-message-list" role="list" aria-live="polite">
      {props.messages.map((next, index) => {
        const preview = nextPreview(next);
        const busy = props.busyId === next.deliveryId;
        return (
          <div
            className={`next-message${next.editing ? " is-editing" : ""}`}
            role="listitem"
            key={next.deliveryId}
          >
            <span className="next-message-copy">
              <strong>
                {next.editing
                  ? "Editing queued message"
                  : index === 0
                    ? "Next message to send after thread finishes"
                    : `Then · ${index + 1}`}
              </strong>
              <span title={preview}>{preview}</span>
            </span>
            <button
              type="button"
              className="btn btn-quiet next-message-cancel"
              disabled={busy}
              aria-label={
                next.editing
                  ? "Cancel queued message edit"
                  : "Cancel queued message"
              }
              onClick={() =>
                next.editing ? props.onCancelEdit(next) : props.onCancel(next)
              }
            >
              {busy ? "Working…" : next.editing ? "Cancel edit" : "Cancel"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export interface ContextRebuildUndo {
  eventId: number;
  driver: string;
}

/**
 * A cross-provider switch is undoable until a run starts under the new
 * provider. Derive that window from the journal so it survives a renderer
 * reload; the server repeats the check before restoring anything.
 */
export function pendingContextRebuild(
  events: readonly JournalEvent[],
): ContextRebuildUndo | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === "session_started") return null;
    if (event.type !== "model_changed") continue;
    const payload =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};
    if (payload.contextRebuilt !== true || payload.undo === true) return null;
    const to =
      typeof payload.to === "object" && payload.to !== null
        ? (payload.to as Record<string, unknown>)
        : {};
    return {
      eventId: event.id,
      driver: typeof to.driver === "string" ? to.driver : "the new agent",
    };
  }
  return null;
}

export function ContextRebuildNotice(props: {
  change: ContextRebuildUndo;
  busy: boolean;
  onUndo(): void;
}): ReactNode {
  return (
    <div className="context-rebuild-notice" role="status" aria-live="polite">
      <span className="context-rebuild-copy">
        <strong>Context will rebuild on your next message</strong>
        <span>Switching to {props.change.driver}</span>
      </span>
      <button
        type="button"
        className="btn btn-quiet context-rebuild-undo"
        disabled={props.busy}
        onClick={props.onUndo}
      >
        {props.busy ? "Restoring…" : "Undo"}
      </button>
    </div>
  );
}

function imageDraft(image: ImagePart): Attachment {
  return {
    blobId: image.blobId,
    mediaType: image.mediaType,
    bytes: 0,
    ...(image.width !== undefined ? { width: image.width } : {}),
    ...(image.height !== undefined ? { height: image.height } : {}),
    ...(image.alt !== undefined ? { name: image.alt } : {}),
  };
}

function putNext(current: NextMessage[], next: NextMessage): NextMessage[] {
  const at = current.findIndex((item) => item.deliveryId === next.deliveryId);
  if (at < 0) return [...current, next];
  return current.map((item, index) => (index === at ? next : item));
}

export function useNextMessageControls(
  sessionId: string,
  setMessages: Dispatch<SetStateAction<NextMessage[]>>,
  onError: (message: string) => void,
): {
  busyId: string | null;
  cancel(next: NextMessage): void;
  cancelEdit(next: NextMessage): void;
} {
  const { api, drafts } = useHarness();
  const [busyId, setBusyId] = useState<string | null>(null);
  const cancel = useCallback(
    (next: NextMessage) => {
      if (busyId !== null) return;
      setBusyId(next.deliveryId);
      api
        .cancelNextMessage(sessionId, next.deliveryId)
        .then(({ cancelled }) => {
          if (cancelled) {
            setMessages((current) =>
              current.filter((item) => item.deliveryId !== next.deliveryId),
            );
            if (drafts.get(sessionId).queuedDeliveryId === next.deliveryId) {
              drafts.clear(sessionId);
            }
          }
        })
        .catch((error: unknown) =>
          onError(error instanceof Error ? error.message : String(error)),
        )
        .finally(() => setBusyId(null));
    },
    [api, busyId, drafts, onError, sessionId, setMessages],
  );
  const cancelEdit = useCallback(
    (next: NextMessage) => {
      if (busyId !== null) return;
      setBusyId(next.deliveryId);
      api
        .cancelNextMessageEdit(sessionId, next.deliveryId)
        .then((updated) => {
          setMessages((current) => putNext(current, updated));
          drafts.clear(sessionId);
        })
        .catch((error: unknown) =>
          onError(error instanceof Error ? error.message : String(error)),
        )
        .finally(() => setBusyId(null));
    },
    [api, busyId, drafts, onError, sessionId, setMessages],
  );
  return { busyId, cancel, cancelEdit };
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
        ...(choice.effort !== null ? { effort: choice.effort } : {}),
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
      skillDriver={choice.driver}
      footer={
        <>
          <ModelSelector value={choice} onChange={setChoice} disabled={busy} />
          <span className="composer-spacer" />
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
 * The mark is the shortcut itself — ⌘⏎ drawn as an icon — so the button
 * teaches the keys that press it and the footer no longer needs a kbd hint
 * repeating them. What the old verb was carrying is the *distinction* —
 * dispatching starts a run, sending steers one — and that survives in the
 * accessible name and the tooltip, where it is available on demand instead of
 * taking a third of the footer to say something the placeholder already said.
 *
 * In flight it wears the running ring, the same glyph a live run wears
 * everywhere else in the window, rather than a spinner this app does not
 * otherwise own.
 */
export function SendButton(props: {
  busy: boolean;
  disabled: boolean;
  label: string;
  busyLabel: string;
  onClick(): void;
  /**
   * The ⇧⌘⏎ action, when the thread has one: queue the message for the moment
   * the current run ends. Present, the button becomes a split control — the
   * main segment sends now, a ⇧ segment defers — so the chord's two variants
   * are two visible targets rather than a kbd hint beside one.
   */
  defer?: { label: string; onClick(): void };
}): ReactNode {
  const unavailable = props.busy || props.disabled;
  const main = (
    <button
      type="button"
      className="btn btn-primary btn-icon composer-send"
      disabled={unavailable}
      aria-label={props.busy ? `${props.busyLabel}…` : props.label}
      aria-busy={props.busy}
      title={props.busy ? `${props.busyLabel}…` : `${props.label} (⌘⏎)`}
      onClick={props.onClick}
    >
      {props.busy ? <StatusGlyph status="running" /> : <SendIcon />}
    </button>
  );
  if (props.defer === undefined) return main;
  return (
    <span className="composer-send-split">
      {main}
      <button
        type="button"
        className="btn btn-primary btn-icon composer-send-defer"
        disabled={unavailable}
        aria-label={props.defer.label}
        title={`${props.defer.label} (⇧⌘⏎)`}
        onClick={props.defer.onClick}
      >
        <ShiftIcon />
      </button>
    </span>
  );
}

/**
 * Kills the run this composer is steering. It lives beside the send mark —
 * the two controls that change what the thread does next, in one place —
 * rather than up on the panel bar with the facts.
 *
 * Stopping is the one irreversible control here, and it used to give no sign
 * it had been pressed until the server frame came back; two clicks sent two
 * kills. `stopping` disarms it after the first.
 */
export function StopButton(props: {
  stopping: boolean;
  onClick(): void;
}): ReactNode {
  return (
    <button
      type="button"
      className="btn btn-danger btn-icon composer-stop"
      disabled={props.stopping}
      aria-busy={props.stopping}
      aria-label={props.stopping ? "Stopping…" : "Stop this thread"}
      title={props.stopping ? "Stopping…" : "Stop this thread"}
      onClick={props.onClick}
    >
      <StopIcon />
    </button>
  );
}

/** Steers a run that already exists. */
export function MessageComposer(props: {
  session: SessionRecord | null;
  id: string;
  nextMessages: NextMessage[];
  contextRebuild: ContextRebuildUndo | null;
  onNextMessages: Dispatch<SetStateAction<NextMessage[]>>;
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
  const controls = useNextMessageControls(
    props.id,
    props.onNextMessages,
    onError,
  );
  const editingId = draft.queuedDeliveryId;
  const editingMode = editingId !== undefined;
  const editing =
    editingId === undefined
      ? null
      : props.nextMessages.find((next) => next.deliveryId === editingId) ?? null;

  // A screenshot with no caption is a message; an empty box with nothing
  // attached is not.
  const sendable = draft.text.trim().length > 0 || draft.attachments.length > 0;

  // `waiting` is stoppable too — a session blocked on a question you do not
  // want to answer is exactly one you might want to kill.
  const stoppable =
    props.session?.status === "running" || props.session?.status === "waiting";
  const [stopping, setStopping] = useState(false);
  const stop = useCallback(() => {
    setStopping(true);
    api
      .stop(props.id)
      .catch((e: unknown) =>
        onError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setStopping(false));
  }, [api, props.id, onError]);

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

  const queue = useCallback(() => {
    if (!sendable || busy || (!running && !editingMode)) return;
    setBusy(true);
    const id = props.id;
    const request =
      !editingMode
        ? api.enqueueNextMessage(
            id,
            draft.text.trim(),
            draft.attachments.map(attachmentInput),
          )
        : api.updateNextMessage(
            id,
            editingId,
            draft.text.trim(),
            draft.attachments.map(attachmentInput),
          );
    request
      .then((next) => {
        drafts.clear(id);
        props.onNextMessages((current) => putNext(current, next));
      })
      .catch((e: unknown) =>
        onError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  }, [
    api,
    draft,
    busy,
    running,
    sendable,
    editingId,
    editingMode,
    props,
    drafts,
    onError,
  ]);

  const editPrevious = useCallback(() => {
    if (busy || props.nextMessages.length === 0) return;
    const next = props.nextMessages[props.nextMessages.length - 1]!;
    setBusy(true);
    api
      .beginNextMessageEdit(props.id, next.deliveryId)
      .then((claimed) => {
        props.onNextMessages((current) => putNext(current, claimed));
        drafts.set(props.id, {
          text: claimed.message,
          attachments: claimed.images.map(imageDraft),
          queuedDeliveryId: claimed.deliveryId,
        });
      })
      .catch((e: unknown) =>
        onError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  }, [api, busy, drafts, onError, props]);

  const usage = props.session?.usage;
  const tokens = usage === undefined ? 0 : usage.tokensIn + usage.tokensOut;

  /**
   * The thread's agent, switchable between runs. The selector shows the
   * binding from the record (which follows `session/updated` frames), with an
   * optimistic override while the switch is in flight so the pill doesn't
   * snap back mid-request. Disabled while the thread is live: the seam
   * refuses a switch under a running driver, and a greyed control explains
   * that better than a 409 after the click.
   */
  const [pendingChoice, setPendingChoice] = useState<ModelChoice | null>(null);
  const [undoingModel, setUndoingModel] = useState(false);
  const [undoneEvent, setUndoneEvent] = useState<number | null>(null);
  const switchAgent = useCallback(
    (next: ModelChoice) => {
      setPendingChoice(next);
      api
        .setModel(props.id, {
          driver: next.driver,
          modelId: next.modelId,
          effort: next.effort,
        })
        .catch((e: unknown) =>
          onError(e instanceof Error ? e.message : String(e)),
        )
        .finally(() => setPendingChoice(null));
    },
    [api, props.id, onError],
  );
  const contextRebuild =
    props.contextRebuild?.eventId === undoneEvent ? null : props.contextRebuild;
  const undoContextRebuild = useCallback(() => {
    if (contextRebuild === null || undoingModel) return;
    const eventId = contextRebuild.eventId;
    setUndoingModel(true);
    api
      .undoModelChange(props.id)
      .then(() => setUndoneEvent(eventId))
      .catch((e: unknown) =>
        onError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setUndoingModel(false));
  }, [api, contextRebuild, onError, props.id, undoingModel]);

  return (
    <Box
      value={draft.text}
      placeholder={
        editingMode
          ? "Edit queued message…"
          : running
            ? "Send a message"
            : "Send a message to resume this thread…"
      }
      disabled={false}
      autoFocus={false}
      attachments={draft.attachments}
      pending={pending}
      onChange={(text) => setDraft({ ...draft, text })}
      onFiles={take}
      onRemove={remove}
      onSubmit={editingMode ? queue : send}
      skillDriver={props.session?.driver ?? ""}
      {...(running && !editingMode ? { onDefer: queue } : {})}
      {...(editing !== null
        ? { onCancelEdit: () => controls.cancelEdit(editing) }
        : {})}
      {...(!editingMode && props.nextMessages.length > 0
        ? { onEditPrevious: editPrevious }
        : {})}
      leading={
        <>
          {contextRebuild !== null && (
            <ContextRebuildNotice
              change={contextRebuild}
              busy={undoingModel}
              onUndo={undoContextRebuild}
            />
          )}
          <NextMessageQueue
            messages={props.nextMessages}
            busyId={controls.busyId}
            onCancel={controls.cancel}
            onCancelEdit={controls.cancelEdit}
          />
        </>
      }
      footer={
        <>
          {props.session !== null && (
            <ModelSelector
              value={
                pendingChoice ?? {
                  driver: props.session.driver,
                  modelId: props.session.modelId,
                  effort: props.session.effort,
                }
              }
              onChange={switchAgent}
              disabled={stoppable || pendingChoice !== null}
              persist={false}
            />
          )}
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
          {/* The send mark says ⌘⏎ and the split's ⇧ segment says the defer
              chord, so the only hint left is the one with keys no button
              draws: the edit pair. */}
          {editingMode && (
            <span
              className="composer-hint"
              title="⌘ Return saves the edit; Escape cancels"
            >
              <kbd>⌘</kbd> <kbd>return</kbd> save · <kbd>esc</kbd> cancel
            </span>
          )}
          {stoppable && <StopButton stopping={stopping} onClick={stop} />}
          <SendButton
            busy={busy}
            disabled={!sendable}
            label={editingMode ? "Save queued message" : "Send"}
            busyLabel={editingMode ? "Saving" : "Sending"}
            onClick={editingMode ? queue : send}
            {...(running && !editingMode
              ? {
                  defer: {
                    label: "Send when this thread ends",
                    onClick: queue,
                  },
                }
              : {})}
          />
        </>
      }
    />
  );
}
