import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

// What Claude is allowed to hand back. Everything is nullable: a task with no
// time signal in it should come back empty rather than have a date invented for
// it, which was the whole objection to doing this in the first place.
const SuggestionSchema = z.object({
  dueDate: z.string().nullable().describe("YYYY-MM-DD, or null if the task implies no particular day"),
  dueTime: z.string().nullable().describe("24h HH:MM, or null if no time of day is implied"),
  priority: z.enum(["low", "medium", "high"]).nullable(),
  category: z.string().nullable().describe("One or two words, e.g. Errands, Work, Health. Null if unclear."),
  reason: z.string().describe("One short phrase naming the words that drove the suggestion, shown to the user"),
});

const SYSTEM = `You turn a short to-do task into scheduling metadata.

Rules:
- Only fill a field when the task text actually supports it. Null is the correct
  answer far more often than a guess. Never invent a date the user did not imply.
- "tomorrow", "next Friday", "in 2 weeks" are relative to the user's today, given below.
- A task like "pick up package" implies a day only if the text says so. But phrases
  like "before the 15th", "by Friday", "9am standup" are explicit - use them.
- dueTime only when a time of day is genuinely implied (meetings, calls, appointments,
  flights, reservations, "morning"/"evening" -> pick a sensible hour).
- priority: high for deadlines, money, health, or anything with a consequence for
  slipping; low for someday/maybe wording. Null when it reads neutral.
- reason: name the actual trigger words, e.g. "'by Friday'" or "'dentist appointment'".
  Keep it under 8 words. It is shown to the user so they can judge your suggestion.`;

const client = new Anthropic();

export async function POST(req: Request): Promise<Response> {
  let body: { text?: unknown; today?: unknown; timeZone?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const today = typeof body.today === "string" ? body.today : "";
  const timeZone = typeof body.timeZone === "string" ? body.timeZone : "UTC";

  if (!text) return Response.json({ error: "Missing task text" }, { status: 400 });
  if (text.length > 500) return Response.json({ error: "Task text too long" }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return Response.json({ error: "today must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 1024,
      // Extraction this small does not need deep reasoning; low effort keeps the
      // per-task cost down, which matters because this fires while the user types.
      output_config: { effort: "low", format: zodOutputFormat(SuggestionSchema) },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Today is ${today} (${timeZone}).\n\nTask: ${text}`,
        },
      ],
    });

    // A refusal comes back as HTTP 200 with no parsed output - treat it as "no
    // suggestion" so the client silently falls back to its offline keyword nudge.
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return Response.json({ suggestion: null });
    }

    const s = response.parsed_output;
    // The model is instructed to use these formats, but it is not a schema
    // constraint - drop anything malformed rather than writing it into a task.
    const dueDate = s.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(s.dueDate) ? s.dueDate : null;
    const dueTime = s.dueTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.dueTime) ? s.dueTime : null;

    return Response.json({
      suggestion: {
        dueDate,
        // A time without a day has nowhere to live in the calendar view.
        dueTime: dueDate ? dueTime : null,
        priority: s.priority ?? null,
        category: s.category ? s.category.slice(0, 24) : null,
        reason: s.reason ? s.reason.slice(0, 80) : "",
      },
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return Response.json({ error: "Busy, try again shortly" }, { status: 429 });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("ANTHROPIC_API_KEY missing or invalid");
      return Response.json({ error: "Analysis unavailable" }, { status: 503 });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return Response.json({ error: "Analysis unavailable" }, { status: 503 });
    }
    console.error("analyze failed", err);
    return Response.json({ error: "Analysis failed" }, { status: 500 });
  }
}
