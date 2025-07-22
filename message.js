/**
 * Message templates for the ticket system
 */

const messages = {
    INITIAL_MESSAGE: `{userTag}

📌 Automated Ticket Handling
To resolve your issue quickly, please provide:
1️⃣ Your EVM address (paste it here)
2️⃣ Description of the issue (clear and concise)
3️⃣ Screenshot displaying the problem

⚠️ Missing details may delay resolution`,

    FORM_MESSAGE: `🔹 **How to Access Mining SATs Activity**

Fill out the Google Form:
→ [Mining SATs Access Form](https://docs.google.com/forms/d/e/1FAIpQLSfsEm1xSQe4XBg7epvnXk093EuJwUjr1J7NkE3WkftbB8yk0A/viewform)


Requirement: You must have the **Human** role

Don’t have it? Use **!human** command and follow the instructions

⏳ *This ticket will auto-close in 1 hour*`
};

module.exports = messages;