const teachableClient = require("./teachableCourses.client");

/**
 * Looks up a Teachable course by ID against the live Teachable API
 * (GET /v1/courses/{id}, confirmed against docs.teachable.com/reference/showcourse)
 * instead of a static mapping file, so a course added, renamed, or deleted
 * on the Teachable side is reflected on the very next completion with no
 * manual mapping step. Returns null if the course no longer exists (deleted,
 * or a stale/bad course_id), which the caller treats as a terminal,
 * non-retryable outcome — never as a reason to auto-create anything.
 */
const getCourseById = async (courseId) => {
  const { data, status } = await teachableClient.request({
    method: "GET",
    url: `/courses/${courseId}`,
  });

  if (status === 404 || !data) return null;

  const course = data.course || data;
  return { id: course.id ?? courseId, name: course.name };
};

/**
 * Reads one learner's progress on one course (GET /v1/courses/{id}/progress,
 * confirmed against docs.teachable.com/reference/courseprogress). This is the
 * only place Teachable exposes a real completion timestamp: the
 * Enrollment.completed webhook payload does not carry one. `completed_at` is a
 * nullable ISO8601 field; see the note below on where it actually sits.
 *
 * Returns null when the course/user pair has no progress record (404).
 * `completedAt` is null when the learner has not completed the course.
 */
const getCourseProgress = async (courseId, userId) => {
  const { data, status } = await teachableClient.request({
    method: "GET",
    url: `/courses/${courseId}/progress`,
    params: { user_id: userId },
  });

  if (status === 404 || !data) return null;

  // Verified against the live API (2026-09-17): the payload is nested under a
  // `course_progress` key, the same convention GET /courses/{id} uses for
  // `course`. The published schema shows these fields at the top level, so both
  // shapes are tolerated — reading only the documented one silently yielded a
  // null completed_at on every real response.
  const progress = data.course_progress || data;

  return {
    completedAt: progress.completed_at ?? null,
    percentComplete: progress.percent_complete ?? null,
  };
};

module.exports = { getCourseById, getCourseProgress };
