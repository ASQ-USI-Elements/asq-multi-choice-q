var ASQPlugin = require('asq-plugin');
var ObjectId = require('mongoose').Types.ObjectId;
var Promise = require('bluebird');
var coroutine = Promise.coroutine;
var cheerio = require('cheerio');
var mongoose = require('mongoose');
var ObjectId = mongoose.Types.ObjectId;
var assert = require('assert');
var _ = require('lodash');


//http://www.w3.org/html/wg/drafts/html/master/infrastructure.html#boolean-attributes
function getBooleanValOfBooleanAttr(attrName, attrValue){
  if(attrValue === '' || attrValue === attrName){
    return true;
  }
  return false;
}

module.exports = ASQPlugin.extend({
  tagName : 'asq-multi-choice',

  hooks:{
    "parse_html" : "parseHtml",
    "answer_submission" : "answerSubmission",
    // "receivedAnswer" : receivedAnswer,
    // "autoAssess" : autoAssess 
  },

  parseHtml: function(html){
    var $ = cheerio.load(html, {decodeEntities: false});
    var mcQuestions = [];

    $(this.tagName).each(function(idx, el){
      mcQuestions.push(this.processEl($, el));
    }.bind(this));

    //return Promise that resolves with the (maybe modified) html
    return this.asq.db.model("Question").create(mcQuestions)
    .then(function(){
      return Promise.resolve($.root().html());
    });
    
  },

  answerSubmission: coroutine(function *answerSubmissionGen (answer){
    // make sure answer question exists
    var questionUid = answer.questionUid
    var question = yield this.asq.db.model("Question").findById(questionUid).exec(); 
    assert(question,
      'Could not find question with id' + questionUid + 'in the database');

    //make sure it's an answer for an asq-multi-choice question
    if(question.type !== this.tagName) {
      return answer;
    }

    // make sure options are valid
    var options = answer.submission
    assert(_.isArray(options),
      'Invalid answer format, answer.submission should be an array.');

    var sanitized = [];
    var sOptionUids = options.map(function optionMap(option){
      //sanitize
      var option = _.pick(option, 'uid', 'value');
       assert(ObjectId.isValid(option.uid),
        'Invalid answer format, option should have a uid property');

      sanitized.push({_id: ObjectId(option.uid), value: option.value})

      return option.uid;
    });

    var qOptionUids = question.data.options.map(function optionMap2(option){
      return option._id.toString();
    })

    //check if the arrays have the same elements
    assert(_.isEmpty(_.xor(qOptionUids, sOptionUids)),
      'Invalid answer, submitted option uids do not match those in the database');

    answer.submission = sanitized;

    //persist
    yield this.asq.db.model("Answer").create({
      exercise   : answer.exercise_id,
      question   : questionUid,
      answeree   : answer.answeree,
      session    : answer.session,
      submitDate : Date.now(),
      submission : answer.submission,
      confidence : answer.confidence
    });

    this.calculateProgress(answer.session, ObjectId(questionUid));

    //this will be the argument to the next hook
    return answer;
  }),

  calculateProgress: coroutine(function *calculateProgressGen(session_id, question_id){
    var criteria = {session: session_id, question:question_id};
    var answers = yield this.asq.db.model('Answer').find(criteria).lean().exec();
    var options = {};
    answers.reduce(function reduceAnswers(options, answer){
      answer.submission.forEach(function forEachSubmission(sub){
        if(sub.value == false) return;

        //options is true so add it
        var id = sub._id.toString();
        options[id] = options[id] || 0;
        options[id]++;
      })
      return options;
    }, options);

    var event = {
      questionType: this.tagName,
      type: 'progress',
      questionUid: question_id.toString(),
      options: options,
      total: answers.length
    }

    this.asq.command('sendSocketEventToNamespaces', 'asq:question_type', event, session_id.toString(), 'ctrl')
  }),

  processEl: function($, el){

    var $el = $(el);

    //make sure question has a unique id
    var uid = $el.attr('uid');
    if(uid == undefined || uid.trim() == ''){
      $el.attr('uid', uid = ObjectId().toString() );
    } 

    //get stem
    var stem = $el.find('asq-stem');
    if(stem.length){
      stem = stem.eq(0).html();
    }else{
      stem = '';
    }

    //parse options
    var options = this.parseOptions($, el);

    return {
      _id : uid,
      type: this.tagName,
      data: {
        stem: stem,
        options: options
      }
    }

  },

  parseOptions: function($, el){
   
    var dbOptions = [];
    var ids = Object.create(null);
    var $el = $(el);

    var $asqOptions = $el.find('asq-option');
    assert($asqOptions.length > 1
      , 'A multi-choice question should have at least two asq-options children' )

    $asqOptions.each(function(idx, option){
      $option = $(option);

      //make sure optiosn are id'ed
      var uid = $option.attr('uid');
      if(uid == undefined || uid.trim() == ''){
        $option.attr('uid', uid = ObjectId().toString() );
      } 

      assert(!ids[uid]
        , 'A multi-choice question cannot have two options with the same uids' );
     
      ids[uid] = true;

      //check if the options is marked as a correct choice
      var correct = getBooleanValOfBooleanAttr("correct", $option.attr('correct'));

      //remove correct Attr so that it doesn't get served in HTML
      $option.removeAttr('correct');

      dbOptions.push({
        _id : ObjectId(uid),
        html: $option.html(),
        correct : correct
      });
    });

    return dbOptions;
  } 
});