
const args = getCmdArguments();

const { ticket: issueKey, repo, authToken, ghToken, orgId, botId, updateOnly, ticketType = "issues", testMode } = args;
const padNumber = (number) => number.toString().padStart(5, '0');
const isIssue = ticketType === "issues";
const issueApiUrl = `https://api.github.com/repos/${repo}/${ticketType}/${issueKey}`;

await (async function () {
    try {
        const issueDetails = await gitFetch(issueApiUrl);
        console.log(`Done fetching ${ticketType} details`);

        const comments = issueDetails.comments ? await gitFetch(issueDetails.comments_url ?? `${issueApiUrl}/comments`) : [];
        console.log(`Done fetching ${ticketType} comments`);

        const repoLabels = !updateOnly && ticketType === 'issues' && await gitFetch(`https://api.github.com/repos/${repo}/labels`);
        console.log("Done fetching repo labels");

        const apiResponse = await callResponder(issueDetails, comments, repoLabels, updateOnly);
        console.log("Done getting response from bot");

        if (updateOnly) {
            console.log("Done updating resource center");
            return;
        }

        if (apiResponse.completionCost) {
            console.log("Cost incurred for processing this ticket", apiResponse.completionCost);
        }

        await updateGitHubIssue(issueDetails, apiResponse);
        console.log("Done with updating ticket");
    } catch (error) {
        console.error(`Error: ${error.message}`, error);
    }
})();


function gitFetch(url, body, method) {
    const options = { headers: { 'Content-Type': 'application/json' } };
    if (ghToken) {
        options.headers = { ...options.headers, Authorization: `token ${ghToken}` };
    }

    if (body) {
        options.method = method || 'POST';
        options.body = body;
    }

    return callAPI(url, options);
}

async function callAPI(url, options) {
    if (options?.body && typeof options.body === 'object') {
        options.body = JSON.stringify(options.body);
    }
    console.log('About to hit url: ', url);
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`Error calling API: ${response.statusText}; ${await response.text()}`);
    return await response.json();
}

async function callResponder(issueDetails, comments, repoLabels, updateOnly) {
    let labels = issueDetails.labels.map(label => label.name).join(',');
    if (labels) {
        labels = `\nLabels: ${labels}`
    }

    const { number, state, title, body } = issueDetails;

    let commentsContent = comments.map(comment =>
        `* ${comment.user.login} commented on ${new Date(comment.created_at).toISOString()}:\n${comment.body}`
    ).join('---------');

    if (commentsContent) {
        commentsContent = `Comments: ${commentsContent}`;
    }

    const content = `
${isIssue ? 'Issue' : 'Discussion'} number:${number} (${state})
Title: ${title}${labels}
Created by: ${issueDetails.user.login} on ${new Date(issueDetails.created_at).toISOString()}
Body: ${body}
${commentsContent}
`.trim();
    const customId = isIssue ? `g_issue_${padNumber(number)}` : `g_discussion_${padNumber(number)}`;
    const requestBody = { customId, content };

    const basePath = 'https://335k3gia6uavyfimzvao2l6fzy0wuajw.lambda-url.ap-south-1.on.aws';

    let apiUrl = `${basePath}/responder/resource/${orgId}/${botId}`;

    if (!updateOnly) {
        apiUrl = `${basePath}/responder/${orgId}/${botId}/github`;
        if (isIssue) {
            requestBody.labels = repoLabels?.map(label => ({ text: label.name, description: label.description }));
        }

        if (testMode) {
            requestBody.testMode = true;
        }
    }

    return await callAPI(apiUrl, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `token ${authToken}`
        }, method: 'POST', body: requestBody
    });
}

const defaultDisclaimer = "**Disclaimer**: Please note that this response has been generated automatically by an AI bot. While we strive for accuracy, there may be instances where the information is incorrect or inappropriate. We review these responses periodically and will make necessary corrections as needed. We appreciate your understanding.";
const closedTicketDisclaimer = "**Disclaimer**: This ticket has been closed based on the information provided. Please note that this response was generated automatically by an AI bot, and while we strive for accuracy, there may be instances where the information is incorrect or inappropriate. If you believe it is inappropriate to close this ticket or if you have further issues to discuss, you are welcome to reopen the ticket. It will be reviewed manually at a later point. Thank you for your understanding.";

async function updateGitHubIssue(issueDetails, apiResponse) {
    if (!apiResponse.isSuccess) {
        console.warn("No updates made as the AI call is not successful:", apiResponse);
        return;
    }

    const comment = apiResponse.comment && `${apiResponse.comment}\n\n---\n${issueDetails.state !== 'closed' ? defaultDisclaimer : closedTicketDisclaimer}`;
    if (comment) {
        await gitFetch(`https://api.github.com/repos/${repo}/${ticketType}/${issueKey}/comments`, { body: comment });
    }

    let updateData = {};
    if (apiResponse.status && issueDetails.state !== apiResponse.status) {
        updateData.state = apiResponse.status;

        if (apiResponse.state_reason && apiResponse.state_reason !== 'null') {
            updateData.state_reason = apiResponse.state_reason;
        }
    }

    if (apiResponse.labels && apiResponse.labels.length > 0) {
        updateData.labels = apiResponse.labels;
    }

    if (Object.keys(updateData).length > 0) {
        await gitFetch(`${issueDetails.repository_url}/${ticketType}/${issueKey}`, updateData, 'PATCH');
    }
}


function getCmdArguments() {
    const args = process.argv.slice(2);
    const result = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith('--')) {
            const key = arg.slice(2); // Remove the leading '--'
            const value = args[i + 1];

            // Check if the next item exists and is not another key
            if (value && !value.startsWith('--')) {
                result[key] = value;
                i++; // Increment i to skip the value
            } else {
                result[key] = value ?? true; // Default to true if no value
                if (!value) {
                    i++; // Increment i to skip the value just in case if empty value is passed
                }
            }
        } else {
            console.error(`Invalid argument: ${arg}`);
            process.exit(1);
        }
    }

    return result;
}