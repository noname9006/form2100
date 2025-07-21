/**
 * Message templates for the ticket system
 */

const messages = {
    INITIAL_MESSAGE: `{userTag}

Tickets in this category are handled automatically
Please paste your evm address, description and a screenshot displaying the issue`,

    FORM_MESSAGE: `To get access to Mining SATs activity, fill out the google form:
@https://docs.google.com/forms/d/e/1FAIpQLSfsEm1xSQe4XBg7epvnXk093EuJwUjr1J7NkE3WkftbB8yk0A/viewform

**Please note: you need to have Human role to get access to the activity. To get the role, use !human command and follow the instructions**

The ticket will be automatically closed in one hour`
};

module.exports = messages;