const Joi = require('joi');

const commonSchemas = {
    email: Joi.string().email().required(),
};

module.exports = commonSchemas;
