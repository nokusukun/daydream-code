import type { Context } from "@daydream-code/kernel";
import type { Answers, Question, QuestionOption } from "@daydream-code/questions";
import type {} from "./index.js";
import type {} from "@daydream-code/questions";

/** Mirrors the Claude SDK's `AskUserQuestion` bounds, which are well-tuned. */
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_HEADER = 12;

interface RawOption {
  label?: unknown;
  description?: unknown;
}

interface RawQuestion {
  question?: unknown;
  header?: unknown;
  options?: unknown;
  multiSelect?: unknown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalize model-authored input. The Claude adapter's JSON Schema -> zod
 * conversion is structural but not enforcing (bounds like "2-4 options" do not
 * survive it), so the tool validates its own arguments rather than trusting
 * that anything upstream did.
 */
function parseQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("`questions` must be a non-empty array");
  }
  if (raw.length > MAX_QUESTIONS) {
    throw new Error(
      `ask at most ${MAX_QUESTIONS} questions at once; got ${raw.length}. Ask the most decision-changing ones now and the rest after these are answered.`,
    );
  }
  return raw.map((entry: RawQuestion, index): Question => {
    const question = str(entry?.question);
    if (!question) {
      throw new Error(`questions[${index}].question is required`);
    }
    const rawOptions = Array.isArray(entry?.options) ? entry.options : [];
    const options = rawOptions.map((option: RawOption, o): QuestionOption => {
      const label = str(option?.label);
      if (!label) {
        throw new Error(`questions[${index}].options[${o}].label is required`);
      }
      return { label, description: str(option?.description) };
    });
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      throw new Error(
        `questions[${index}] needs ${MIN_OPTIONS}-${MAX_OPTIONS} options; got ${options.length}. If the answer is genuinely open-ended, it is not a multiple-choice question — ask it in your turn text instead.`,
      );
    }
    const labels = new Set(options.map((option) => option.label));
    if (labels.size !== options.length) {
      throw new Error(`questions[${index}] has duplicate option labels`);
    }
    // The id must be the question text: it is what the answering surface keys
    // its draft answers by, and what the SDK's own AskUserQuestion uses.
    return {
      id: question,
      header: str(entry?.header).slice(0, MAX_HEADER) || `Q${index + 1}`,
      question,
      options,
      multiSelect: entry?.multiSelect === true,
    };
  });
}

/** Render answers back to the model in the same vocabulary it asked in. */
function describeAnswers(questions: Question[], answers: Answers): string {
  return questions
    .map((q) => {
      const answer = answers[q.id];
      const text = Array.isArray(answer) ? answer.join(", ") : (answer ?? "(no answer)");
      return `${q.question}\n  -> ${text}`;
    })
    .join("\n");
}

/**
 * Consumer plugin: the one tool that lets a session stop and ask.
 *
 * The turn blocks inside this tool call. That is the point, and it is why the
 * answer cannot travel the injection path: `drainInjections()` only runs at
 * turn boundaries, and this call is mid-turn. The answer resolves the promise
 * directly, through the `questions` seam.
 *
 * Claude only. The Codex SDK exposes no custom-tool surface at all
 * (`driver/src/codex.ts`), so a Codex session has no way to reach this and
 * must state its assumptions in prose instead.
 */
const askTools = {
  name: "ask-tools",
  inject: ["tools", "questions"],
  apply(ctx: Context) {
    ctx.tools.register(ctx, {
      name: "ask_user",
      description: [
        "Ask the user a multiple-choice question and wait for their answer. The session blocks until they respond, so the answer is worth the wait or the question should not be asked.",
        "",
        "Explore before you ask. Never ask what the repository can tell you — read the files, grep for the convention, check the config. Ask only about things exploration cannot settle: product intent, priorities, and tradeoffs between options that are all defensible.",
        "",
        "Every question must materially change what you build, confirm a load-bearing assumption, or pick between real alternatives. Give 2-4 mutually exclusive options with honest descriptions of what each one costs. Do not pad with an option you know is wrong, and do not add an 'other' choice — the user can always write their own answer.",
        "",
        "The user may hand the decision back to you. If they do, proceed with the option you recommended and say plainly in your summary that you assumed it.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: `${MIN_OPTIONS}-${MAX_OPTIONS} options each; at most ${MAX_QUESTIONS} questions per call.`,
            items: {
              type: "object",
              properties: {
                question: {
                  type: "string",
                  description:
                    "The full question, ending in a question mark. Specific enough to answer without scrolling back.",
                },
                header: {
                  type: "string",
                  description: `Chip label, <= ${MAX_HEADER} chars. E.g. "Storage", "Rollout".`,
                },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: {
                        type: "string",
                        description: "The choice itself, 1-5 words.",
                      },
                      description: {
                        type: "string",
                        description:
                          "What picking this actually means — the tradeoff, not a restatement of the label.",
                      },
                    },
                    required: ["label", "description"],
                  },
                },
                multiSelect: {
                  type: "boolean",
                  description:
                    "True if the options combine rather than exclude. Phrase the question accordingly.",
                },
              },
              required: ["question", "header", "options"],
            },
          },
        },
        required: ["questions"],
      },
      async execute(args: { questions?: unknown }, run) {
        const questions = parseQuestions(args?.questions);
        const outcome = await ctx.questions.ask(run.sessionId, questions);
        switch (outcome.kind) {
          case "answered":
            return {
              status: "answered",
              answers: outcome.answers,
              summary: describeAnswers(questions, outcome.answers),
            };
          case "replied":
            // Prose instead of a pick. Passed through verbatim: mapping it onto
            // option labels would be the tool guessing on the user's behalf.
            return {
              status: "replied",
              reply: outcome.text,
              guidance:
                "The user answered in their own words rather than picking an option. Take the reply as authoritative, including where it contradicts the options you offered.",
            };
          case "declined":
            return {
              status: "declined",
              guidance:
                "The user handed the decision back to you. Proceed with the option you recommended, and record it as an assumption in your summary so they can overrule it later.",
            };
          case "cancelled":
            return {
              status: "cancelled",
              reason: outcome.reason,
              guidance:
                "Nobody is going to answer — do not ask again this turn. Proceed with your recommended option and record it as an assumption.",
            };
        }
      },
    });
  },
};

export default askTools;
