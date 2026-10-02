jest.mock("../../../src/services/teachableCourses.client", () => ({ request: jest.fn() }));
const teachableClient = require("../../../src/services/teachableCourses.client");
const {
  getCourseById,
  getCourseProgress,
} = require("../../../src/services/teachableCourses.service");

describe("teachableCourses.service", () => {
  beforeEach(() => {
    teachableClient.request.mockReset();
  });

  test("returns id/name for a course nested under a `course` key", async () => {
    teachableClient.request.mockResolvedValue({
      data: { course: { id: 101, name: "First Aid Training" } },
      status: 200,
    });
    const result = await getCourseById(101);
    expect(result).toEqual({ id: 101, name: "First Aid Training" });
    expect(teachableClient.request).toHaveBeenCalledWith({ method: "GET", url: "/courses/101" });
  });

  test("returns null when the course is not found", async () => {
    teachableClient.request.mockResolvedValue({ data: null, status: 404 });
    const result = await getCourseById(999);
    expect(result).toBeNull();
  });

  test("propagates a retryable client error to the caller", async () => {
    teachableClient.request.mockRejectedValue(
      Object.assign(new Error("Teachable API Error: rate limited"), {
        errorCode: "RATE_LIMITED",
        retryable: true,
      }),
    );
    await expect(getCourseById(101)).rejects.toMatchObject({ errorCode: "RATE_LIMITED" });
  });

  // GET /v1/courses/{id}/progress is the only Teachable source of a real
  // completion timestamp; completed_at is top-level and nullable.
  describe("getCourseProgress", () => {
    // Shape confirmed against the live API (2026-09-17): nested under
    // `course_progress`, alongside a `meta` block. The published schema shows
    // these fields at the top level; reading only that shape produced a null
    // completed_at for every real response.
    test("reads completed_at from the nested course_progress object", async () => {
      teachableClient.request.mockResolvedValue({
        data: {
          course_progress: {
            id: 555,
            completed_at: "2026-09-17T05:27:52Z",
            enrolled_at: "2026-09-16T13:04:55Z",
            percent_complete: 100,
            lecture_sections: [],
          },
          meta: { total: 1, page: 1, per_page: 20 },
        },
        status: 200,
      });

      const result = await getCourseProgress(2968746, 130785911);

      expect(result).toEqual({ completedAt: "2026-09-17T05:27:52Z", percentComplete: 100 });
      expect(teachableClient.request).toHaveBeenCalledWith({
        method: "GET",
        url: "/courses/2968746/progress",
        params: { user_id: 130785911 },
      });
    });

    test("still reads a flat response, the shape the published schema documents", async () => {
      teachableClient.request.mockResolvedValue({
        data: { completed_at: "2026-09-17T05:27:52Z", percent_complete: 100 },
        status: 200,
      });
      await expect(getCourseProgress(101, 7)).resolves.toEqual({
        completedAt: "2026-09-17T05:27:52Z",
        percentComplete: 100,
      });
    });

    test("returns a null completedAt when the learner has not completed the course", async () => {
      teachableClient.request.mockResolvedValue({
        data: { course_progress: { completed_at: null, percent_complete: 40 } },
        status: 200,
      });
      await expect(getCourseProgress(101, 7)).resolves.toEqual({
        completedAt: null,
        percentComplete: 40,
      });
    });

    test("returns null when no progress record exists", async () => {
      teachableClient.request.mockResolvedValue({ data: null, status: 404 });
      await expect(getCourseProgress(101, 7)).resolves.toBeNull();
    });
  });
});
