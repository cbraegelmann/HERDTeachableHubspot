const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const deepMerge = (target, source) => {
  const output = { ...target };
  for (const key of Object.keys(source)) {
    if (isPlainObject(source[key]) && isPlainObject(target[key])) {
      output[key] = deepMerge(target[key], source[key]);
    } else {
      output[key] = source[key];
    }
  }
  return output;
};

/**
 * Builds a Teachable Enrollment.completed payload matching the verbatim
 * structure documented at docs.teachable.com/docs/available-events, with
 * course 101 as the default course. Pass overrides for scenario-specific
 * fields, e.g. buildEnrollmentCompletedPayload({ object: { id: 42 } }).
 */
const buildEnrollmentCompletedPayload = (overrides = {}) => {
  const base = {
    type: "Enrollment.completed",
    id: 1234567,
    livemode: true,
    created: "2022-05-27T14:47:25+00:00",
    hook_event_id: 12345678,
    object: {
      created_at: "2022-05-27T14:46:57Z",
      updated_at: "2022-05-27T14:46:57Z",
      user_id: 1234567,
      course_id: 101,
      primary_course_id: 101,
      sale_id: 1234567,
      is_active: true,
      enrolled_at: "2022-05-27T14:46:57Z",
      percent_complete: 100,
      has_full_access: false,
      id: 987654321,
      course_progress_id: 12345678,
      certificate_serial_number: null,
      user: { id: 73647851, email: "student@example.com", name: "John Doe" },
      course: { id: 101, name: "First Aid Training" },
    },
  };

  return deepMerge(base, overrides);
};

module.exports = { buildEnrollmentCompletedPayload };
