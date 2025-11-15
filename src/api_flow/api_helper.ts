import axios from 'axios';
import { callLLMForApiAnswers } from './llm'; // Import the new LLM function

// Types for API responses (can be refined based on actual Luma API docs if available)
export interface APIRegistrationQuestion {
    id: string;
    label: string;
    required: boolean;
    question_type: 'linkedin' | 'phone-number' | 'dropdown' | 'text' | 'multi-select' | string; // string for other types
    options?: string[];
}

export interface APITicketType {
    api_id: string;
    name: string;
    type: string; // e.g., 'free'
    require_approval: boolean;
    is_hidden: boolean;
    is_disabled: boolean;
    is_sold_out: boolean;
    valid_end_at: string | null;
    // Add other relevant ticket properties
}

export interface APIEventDetails {
    event_api_id: string;
    name: string;
    registration_questions: APIRegistrationQuestion[];
    ticket_types: APITicketType[];
    // Add other relevant event detail properties
}

export interface APIRegistrationAnswer {
    question_id: string;
    question_type: string;
    label: string;
    answer: string | string[] | boolean;
}

/**
 * Fetches the HTML of a Luma event page and extracts the event_api_id.
 */
export async function getEventApiIdFromUrl(eventPageUrl: string): Promise<string | null> {
    console.log(`Fetching event page HTML from: ${eventPageUrl}`);
    try {
        const response = await axios.get(eventPageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const html = response.data;

        const nextDataRegex = /<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/;
        const nextDataMatch = html.match(nextDataRegex);
        if (nextDataMatch && nextDataMatch[1]) {
            try {
                const jsonData = JSON.parse(nextDataMatch[1]);
                const eventId = jsonData.props?.pageProps?.bootstrapApiResponse?.event?.api_id || 
                              jsonData.props?.pageProps?.event?.api_id || 
                              jsonData.props?.pageProps?.event_api_id;
                if (eventId && typeof eventId === 'string' && eventId.startsWith('evt-')) {
                    console.log(`Extracted event_api_id from __NEXT_DATA__: ${eventId}`);
                    return eventId;
                }
            } catch (e) {
                console.warn('Failed to parse __NEXT_DATA__ JSON or find event_api_id in it.', e);
            }
        }

        const genericEventIdRegex = /"event_api_id"\s*:\s*"(evt-[a-zA-Z0-9]+)"/;
        const genericMatch = html.match(genericEventIdRegex);
        if (genericMatch && genericMatch[1]) {
            console.log(`Extracted event_api_id using generic regex: ${genericMatch[1]}`);
            return genericMatch[1];
        }
        
        const specificApiIdRegex = /"api_id"\s*:\s*"(evt-[a-zA-Z0-9]+)"/g;
        let match;
        while ((match = specificApiIdRegex.exec(html)) !== null) {
            const potentialEventId = match[1];
            // Basic check: ensure it's not part of a ticket_type or other nested api_id
            // A truly robust solution would involve parsing the JSON structure containing it.
            const contextWindow = html.substring(Math.max(0, match.index - 50), Math.min(html.length, match.index + 50));
            if (!contextWindow.includes('ticket_type')) { // Simple heuristic
                 console.log(`Found potential event_api_id via specific regex: ${potentialEventId}`);
                 return potentialEventId;
            }
        }

        console.error('Could not extract event_api_id from page HTML.');
        return null;
    } catch (error) {
        console.error(`Error fetching event page ${eventPageUrl}:`, error);
        return null;
    }
}

/**
 * Fetches detailed event information from Luma's API.
 */
export async function fetchEventDetails(eventApiId: string): Promise<APIEventDetails | null> {
    const apiUrl = `https://api.luma.com/event/get?event_api_id=${eventApiId}`;
    console.log(`Fetching event details from: ${apiUrl}`);
    try {
        const response = await axios.get<APIEventDetails>(apiUrl, {
            headers: {
                'Accept': 'application/json',
            }
        });
        return response.data;
    } catch (error) {
        console.error(`Error fetching event details for ${eventApiId}:`, error);
        return null;
    }
}

/**
 * Prepares the answers for the registration questions based on user profile and LLM.
 * (This is a STUB - full implementation needed)
 */
export async function prepareRegistrationAnswers(
    questions: APIRegistrationQuestion[], 
    profileData: Record<string, string>,
    eventName: string, 
    llmConfig: Record<string, string>
): Promise<APIRegistrationAnswer[]> {
    console.log('Preparing registration answers using LLM (sequential mode)...');
    const preparedAnswers: APIRegistrationAnswer[] = [];
    const maxLlmRetries = 3; // Max attempts for LLM call if answer count mismatches
    let llmAttempt = 0;
    let llmSequentialAnswers: (string | string[] | boolean | null)[] | null = null;

    const questionsForLLM = questions.map(q => ({
        id: q.id,
        label: q.label,
        type: q.question_type,
        options: q.options,
        isMandatory: q.required
    }));

    while (llmAttempt < maxLlmRetries && (!llmSequentialAnswers || llmSequentialAnswers.length !== questions.length)) {
        llmAttempt++;
        if (llmAttempt > 1) {
            console.warn(`LLM answer count mismatch or null response. Retrying LLM call (Attempt ${llmAttempt}/${maxLlmRetries})...`);
            await new Promise(resolve => setTimeout(resolve, 2000 * llmAttempt)); // Simple increasing delay
        }
        llmSequentialAnswers = await callLLMForApiAnswers(questionsForLLM, profileData, eventName, llmConfig);
        if (llmSequentialAnswers && llmSequentialAnswers.length !== questions.length && questions.length > 0) {
            console.warn(`LLM returned ${llmSequentialAnswers.length} answers, but ${questions.length} were expected.`);
            // If it's the last attempt and still mismatched, set to null to trigger full fallback
            if (llmAttempt === maxLlmRetries) llmSequentialAnswers = null; 
        }
    }

    if (llmSequentialAnswers && llmSequentialAnswers.length === questions.length) {
        console.log('LLM returned sequential answers. Mapping to questions...');
        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            let llmAnswer = llmSequentialAnswers[i];
            let finalAnswerValue: string | string[] | boolean | null = null;

            if (llmAnswer !== null && llmAnswer !== undefined) {
                finalAnswerValue = llmAnswer;
            } else if (q.required) {
                console.warn(`LLM did not provide a valid answer for mandatory question (index ${i}): "${q.label}". Applying mandatory default.`);
                if (q.question_type === 'agree-check' || q.question_type === 'terms') {
                    finalAnswerValue = true;
                } else if ((q.question_type === 'dropdown' || q.question_type === 'select') && q.options && q.options.length > 0) {
                    finalAnswerValue = q.options[0];
                } else if ((q.question_type === 'multiselect' || q.question_type === 'multi-select') && q.options && q.options.length > 0) {
                    finalAnswerValue = [q.options[0]];
                } else {
                    finalAnswerValue = 'N/A'; // Default for other mandatory text/long-text etc.
                }
            } else {
                // Optional question and LLM didn't provide a usable answer or it was null/undefined
                console.warn(`LLM did not provide a valid answer for optional question (index ${i}): "${q.label}". Applying optional default.`);
                if (q.question_type === 'agree-check' || q.question_type === 'terms') {
                    finalAnswerValue = false; 
                } else if (q.question_type === 'multiselect' || q.question_type === 'multi-select') {
                    finalAnswerValue = []; 
                } else {
                    finalAnswerValue = 'N/A'; // Default for other optional types
                }
            }
            
            // Ensure finalAnswerValue is not null for the payload after LLM processing or defaulting
            let answerForPayload: string | string[] | boolean;
            if (finalAnswerValue === null) { // Should ideally not happen if defaults are applied correctly
                console.warn(`finalAnswerValue is unexpectedly null for question "${q.label}". Applying emergency default.`);
                if (q.question_type === 'agree-check') answerForPayload = false;
                else if (q.question_type === 'multiselect' || q.question_type === 'multi-select') answerForPayload = [];
                else answerForPayload = 'N/A';
            } else {
                answerForPayload = finalAnswerValue;
            }

            preparedAnswers.push({
                question_id: q.id,
                question_type: q.question_type,
                label: q.label,
                answer: answerForPayload
            });
        }
    } else {
        // Fallback: LLM call failed, returned null, or array length mismatch
        const reason = !llmSequentialAnswers ? "LLM call failed or returned null after retries" 
                     : `LLM answer count (${llmSequentialAnswers.length}) still mismatched with question count (${questions.length}) after retries`;
        console.warn(`${reason}. Falling back to basic N/A or first option/default for mandatory fields.`);
        
        for (const q of questions) {
            let answerValue: string | string[] | boolean = 'N/A'; // General default for non-processed
            if (q.required) {
                console.warn(`Fallback for mandatory question: "${q.label}" (type: ${q.question_type}) due to earlier LLM failure/mismatch.`);
                if (q.question_type === 'agree-check' || q.question_type === 'terms') {
                    answerValue = true;
                } else if ((q.question_type === 'dropdown' || q.question_type === 'select') && q.options && q.options.length > 0) {
                    answerValue = q.options[0];
                } else if ((q.question_type === 'multiselect' || q.question_type === 'multi-select') && q.options && q.options.length > 0) {
                    answerValue = [q.options[0]];
                } else {
                    answerValue = 'N/A'; // Default for other mandatory types
                }
            } else {
                console.warn(`Fallback for optional question: "${q.label}" (type: ${q.question_type}) due to earlier LLM failure/mismatch.`);
                if (q.question_type === 'agree-check' || q.question_type === 'terms') {
                    answerValue = false; 
                } else if (q.question_type === 'multiselect' || q.question_type === 'multi-select') {
                    answerValue = []; 
                } else {
                    answerValue = 'N/A'; // Default for other optional types
                }
            }
            preparedAnswers.push({
                question_id: q.id,
                question_type: q.question_type,
                label: q.label,
                answer: answerValue
            });
        }
    }

    console.log('Prepared answers (sequentially from LLM or fallback):', JSON.stringify(preparedAnswers, null, 2));
    return preparedAnswers;
}

/**
 * Submits the event registration via API.
 */
export async function submitRegistration(payload: any, cookieString: string | null, eventPageUrl: string, headersOverride?: Record<string,string>): Promise<any | null> {
    const apiUrl = 'https://api2.luma.com/event/register';
    console.log(`Submitting registration to: ${apiUrl}`);
    // Avoid logging full payload if it's very large or contains sensitive repeated info from profile
    // console.log('Payload:', JSON.stringify(payload, null, 2)); 
    console.log('Submitting payload for event_api_id:', payload.event_api_id);

    // Add random delay before submission to appear more human (3-7 seconds)
    const preDelay = Math.floor(Math.random() * 4000) + 3000;
    console.log(`  Adding human-like delay before submission: ${preDelay}ms`);
    await new Promise(resolve => setTimeout(resolve, preDelay));

    const headers: Record<string, string> = {
        'authority': 'api2.luma.com',
        'accept': '*/*',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'accept-language': 'en',
        'content-type': 'application/json',
        'origin': 'https://luma.com',
        'priority': 'u=1, i',
        'referer': eventPageUrl, // Dynamic referer based on the event page
        // Include non-pseudo equivalents for HTTP/2 pseudo-headers. Note: true pseudo-headers
        // like ':method' cannot be set via Axios (http/1.1). We include their equivalents
        // to match observed browser requests as closely as possible.
        'method': 'POST',
        'path': '/event/register',
        'scheme': 'https',
        'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'x-luma-client-type': 'luma-web',
        'x-luma-client-version': 'b28c5f9b1aa7e8fed961add97128fc95149d0c7d',
        'x-luma-web-url': eventPageUrl // Dynamic based on the event page being registered for
    };

    // Use the dynamically provided cookie string from the browser context.
    // If it's missing, log a warning, as the request will likely fail without authentication.
    if (cookieString) {
        headers['cookie'] = cookieString;
    } else {
        console.warn('  Warning: No cookieString provided to submitRegistration. The request will likely fail.');
        // Consider throwing an error if a cookie is absolutely required.
        // throw new Error('Registration requires a valid cookie string.');
    }

    // Compute and set Content-Length to match the JSON payload the browser would send.
    // Axios/node will set this automatically, but some servers compare the exact header.
    try {
        const payloadString = JSON.stringify(payload);
        const contentLength = Buffer.byteLength(payloadString, 'utf8');
        headers['content-length'] = String(contentLength);
    } catch (e) {
        // If serialization fails for any reason, don't block — let Axios compute it.
        console.warn('Failed to compute content-length for registration payload, proceeding without explicit header.', e);
    }

    // If caller provided header overrides (e.g., exact captured browser headers), merge them in.
    if (headersOverride && typeof headersOverride === 'object') {
        for (const k of Object.keys(headersOverride)) {
            // Do not allow overriding the forced cookie header
            if (k.toLowerCase() === 'cookie') continue;
            headers[k] = headersOverride[k];
        }
    }

    try {
        const response = await axios.post(apiUrl, payload, {
            headers,
            timeout: 30000 // 30 second timeout
        });
        console.log('Registration API response status:', response.status);
        console.log('Registration API response data:', response.data);
        
        // Add delay after successful submission
        const postDelay = Math.floor(Math.random() * 2000) + 1000;
        console.log(`  Adding post-submission delay: ${postDelay}ms`);
        await new Promise(resolve => setTimeout(resolve, postDelay));
        
        return response.data;
    } catch (error: any) {
        console.error('Error submitting registration:');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
            console.error('Headers:', error.response.headers);
            
            // If we get a bot detection error, add longer delay before next attempt
            if (error.response.status === 444 || error.response.status === 429) {
                if (error.response.status === 444) {
                    // Bot detection - wait 1 minute
                    const botDelay = 60000; // 1 minute
                    console.warn(`  Bot detection confirmed (status 444). Waiting 1 minute: ${botDelay}ms`);
                    await new Promise(resolve => setTimeout(resolve, botDelay));
                } else {
                    // Rate limiting - shorter delay
                    const rateDelay = Math.floor(Math.random() * 10000) + 15000; // 15-25 seconds
                    console.warn(`  Rate limiting detected (status 429). Adding delay: ${rateDelay}ms`);
                    await new Promise(resolve => setTimeout(resolve, rateDelay));
                }
            }
        } else if (error.request) {
            console.error('Request (no response received):', error.request);
        } else {
            console.error('Error message:', error.message);
        }
        return null;
    }
} 