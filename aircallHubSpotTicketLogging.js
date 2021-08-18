const hubspot = require('@hubspot/api-client');
const request = require('request');

/* For debugging purposes only! */
const DEBUG = 1;

/* Please adjust the value of these variables based on your specific HubSpot implementation! */
// The ID of your support pipeline (where you want to create a new ticket if required)
const SUPPORT_PIPELINE_ID = 0;
// The ID of the pipeline stage that a ticket would have if it was closed (at this moment, we
// only support one closed pipeline stage)
const PIPELINE_STAGE_CLOSED_ID = 4;
// The ID of the pipleline stage you want to use when creating a new ticket
const NEW_TICKET_PIPLELINE_STAGE_ID = 1;
// The generic subject name of the new ticket (if one is required to be created)
const NEW_TICKET_SUBJECT = "New Deal CX Line";



/******************************************************************
                     PROGRAM STARTS HERE
*******************************************************************/

exports.main = (event, callback) => {
  let apiKey = process.env.hapikey;
  
  // Secrets can be accessed with environment variables.
  // Make sure to add your API key under "Secrets" above.
  const hubspotClient = new hubspot.Client({
    apiKey: apiKey
  });
  
  hubspotClient.crm.contacts.basicApi.getById(event.object.objectId, ["email", "phone"])
    .then(results => {
    	// Get the contact ID that triggered this HS workflow
    	let contactId = results.body.properties.hs_object_id;
    	// Also retrieve the contact's owner ID
    	let contactOwnerId = results.body.properties.hubspot_object_id;
    
    	if (DEBUG) console.log('This is the contact ID: ' + contactId);
    
    	// Set the HS API options to search for all tickets associated with this contact
        var options = {
          "method": "POST",
          "url": `https://api.hubapi.com/crm/v3/objects/tickets/search?hapikey=${apiKey}`,
          "headers": {
        	'Content-Type': 'application/json'
          },
          "body": JSON.stringify({
            "properties": [ "hs_pipeline_stage" ], 
            "filterGroups": [ {
              "filters": [ { 
                "propertyName": "associations.contact", 
                "operator": "EQ", 
                "value": contactId 
              } ] 
            } ],
            "sorts": [ { 
              "propertyName": "createdate", 
              "direction": "DESCENDING" 
            } ]
          })
        };
    
    	// Execute the HS API request
    	request(options, function (error, response, body) {
          	// Retrieve the response
          	let tickets_results = JSON.parse(body).results;
          
          	// Keep track of whether there is at least one "open" ticket, and also
          	// make a list of all ticket IDs that are "open"
          	let atLeastOneOpenTicket = false;
            let contactsTicketIds = [];
             
          	// For each ticket associated with the contact...
            Array.prototype.forEach.call(tickets_results, (ticket) => {
              	// If the ticket is not closed...
            	if (parseInt(ticket.properties.hs_pipeline_stage) != PIPELINE_STAGE_CLOSED_ID) {
                  // Keep track of ticket and that there is at least one "open" ticket
                  contactsTicketIds.push(ticket.id);
                  atLeastOneOpenTicket = true;
                  
                  if (DEBUG) console.log("There is at least one open ticket!");
                }
            });
          
          	// Keep track of the ID of the engagement that was created by Aircall native integration
            // with HS
          	let engagementId;
          
          	// Keep track of whether the engagement is associated with a voicemail
          	let voicemailLeft = false;
          
          	// Set the HS API options to get all recent engagements
          	options = {
            	"method": "GET",
                "url": `https://api.hubapi.com/engagements/v1/engagements/recent/modified?hapikey=${apiKey}`
            };

          	new Promise((resolve) => {
              // Execute the HS API request
              request(options, function (eng_error, eng_response, eng_body) {
                // Retrieve the response
            	let eng_results = JSON.parse(eng_body).results;
                
                // For each engagement found...
                for (let i = 0; i < eng_results.length; i++) {
                  let engagement = eng_results[i];
                  
                  if (DEBUG) console.log('This is the current engagement: ' + engagement.engagement.id);
                  
                  // If the engagement is of type "CALL" and is associated with the contact...
                  if (engagement.engagement.type == "CALL" && engagement.associations.contactIds.includes(parseInt(contactId))) {
                    // Keep track of the engagement ID
                    engagementId = engagement.engagement.id;

                    if (DEBUG) console.log("We found engagement! " + engagementId);

                    // If this engagement is a voicemail...
                    if (engagement.engagement.bodyPreview.includes("Voicemail")) {
                      if (DEBUG) console.log("This is a voicemail! ");
                      
                      // Keep track that a voicemail was left...
                      voicemailLeft = true;
                    }
                    
                    // Exit from searching the remaining engagements
                    break;
                  }
            	}

                resolve();
              });
            }).then(() => {
              
              if (DEBUG) console.log(`This is the engagement: ${engagementId}`);
              if (DEBUG) console.log(`This is voicemailLeft: ${voicemailLeft}`);
              if (DEBUG) console.log(`This is atLeastOneOpenTicket: ${atLeastOneOpenTicket}`);
              
              new Promise((resolve) => {
                // If the engagement that we found is a voicemail and there are no "open" tickets
                // associated with the contact...
                if (voicemailLeft && !(atLeastOneOpenTicket)) {
                  
                  console.log("We should create a new ticket...");
                  
                  // Set the API options for creating a new ticket
                  options = {
                    "method": "POST",
                    "url": `https://api.hubapi.com/crm/v3/objects/tickets?hapikey=${apiKey}`,
                    "headers": {
                      'Content-Type': 'application/json'
                    },
                    "body": JSON.stringify({
                      "properties": {
                        "hs_pipeline": SUPPORT_PIPELINE_ID.toString(),
                        "hs_pipeline_stage": NEW_TICKET_PIPLELINE_STAGE_ID.toString(),
                        "hs_ticket_priority": "LOW",
                        "hubspot_owner_id": contactOwnerId,
                        "subject": NEW_TICKET_SUBJECT
                      }
                    })
                  };

                  // Execute the HS API request
                  request(options, function (ticket_error, ticket_response, ticket_body) {
                    // Retrieve the response and get the ID of the new ticket created
                    let newTicketId = JSON.parse(ticket_body).id;
                    
                    if (DEBUG) console.log(`Finished creating new ticket ${newTicketId}...`)
                    
                    // Set the HS API options to associate this new ticket back to the contact
                    options = {
                      "method": "PUT",
                      "url": `https://api.hubapi.com/crm-associations/v1/associations?hapikey=${apiKey}`,
                      "headers": {
                        'Content-Type': 'application/json'
                      },
                      "body": JSON.stringify({
                        "fromObjectId": contactId,
                        "toObjectId": newTicketId,
                        "category": "HUBSPOT_DEFINED",
                        "definitionId": 15
                      })
                    };

                    // Execute the HS API request
                    request(options, function (associateTicket_error, associateTicket_response, associateTicket_body) {
                      // Keep track of this new ticket for later, as it is now associated to the contact
                      contactsTicketIds.push(newTicketId);
                      
                      if (DEBUG) console.log(`Finished associating contact ${contactId} with ticket ${newTicketId}!`);
                      
                      resolve();
                    });
                  });
                } else {
                  resolve();
                }
              }).then(() => {
                
                if (DEBUG) console.log('Ready to create batch associations with all tickets and engagement...');
                if (DEBUG) console.log(`These are all the ticketIds we need to make an association with engagement ${engagementId}:`);
                if (DEBUG) console.log(contactsTicketIds);
                
                // Create an array of JSON objects, where each one represents a ticket association update we want to make
                // to the engagement
                let batchAssociations = [];
                Array.prototype.forEach.call(contactsTicketIds, (ticketId) => {
                  batchAssociations.push({
                    "fromObjectId": ticketId,
                    "toObjectId": engagementId,
                    "category": "HUBSPOT_DEFINED",
                    "definitionId": 17
                  });
                });
                
                // Set the HS API options to batch update ticket associations to an engagement
                options = {
                  "method": "PUT",
                  "url": `https://api.hubapi.com/crm-associations/v1/associations/create-batch?hapikey=${apiKey}`,
                  "headers": {
                    'Content-Type': 'application/json'
                  },
                  "body": JSON.stringify(batchAssociations)
                };
                
                if (DEBUG) console.log('This is what we will be sending...');
                if (DEBUG) console.log(JSON.stringify(batchAssociations));
                
                // Execute the HS API request
                request(options, function (associateAllTickets_error, associateAllTickets_response, associateAllTickets_body) {
                  if (DEBUG) console.log("Finished associating all tickets!");
                });
              });
            });   
        });
    	
    	callback({ outputFields: {} });
    })
    .catch(err => {
      console.error(err);
      // We will automatically retry when the code fails because of a rate limiting error from the HubSpot API.
      throw err; 
    });
}
