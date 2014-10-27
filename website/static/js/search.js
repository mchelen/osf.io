;(function (global, factory) {
    if (typeof define === 'function' && define.amd) {
        define(['knockout', 'jquery', 'knockoutpunches', 'History', 'osfutils'], factory);
    } else {
        global.Search  = factory(ko, jQuery, History);
    }
}(this, function(ko, $, History) {
    // Enable knockout punches
    ko.punches.enableAll();

    //https://stackoverflow.com/questions/7731778/jquery-get-query-string-parameters
    function qs(key) {
        key = key.replace(/[*+?^$.\[\]{}()|\\\/]/g, '\\$&'); // escape RegEx meta chars
        var match = location.search.match(new RegExp('[?&]'+key+'=([^&]+)(&|$)'));
        return match && decodeURIComponent(match[1].replace(/\+/g, ' '));
    }

    var Category = function(categoryName, categoryCount, alias){
        var self = this;
        self.name = ko.observable(categoryName.charAt(0).toUpperCase() + categoryName.slice(1));

        self.count = ko.observable(categoryCount);
        self.rawName = ko.observable(categoryName);
        self.alias = ko.observable(alias);

        self.getAlias = ko.computed(function() {
            if (self.name() === 'Total') {
                return '';
            }
            return ' AND category:' + self.alias();
        });
    };

    var Tag = function(tagInfo){
        var self = this;
        self.name = ko.observable(tagInfo.key);
        self.count = ko.observable(tagInfo.doc_count);
    };

    var ViewModel = function(url, appURL) {
        var self = this;

        self.queryUrl = url;
        self.appURL = appURL;
        self.tag = ko.observable('');
        self.stateJustPushed = false;
        self.query = ko.observable('');
        self.alias = ko.observable('');
        self.category = ko.observable({});
        self.tags = ko.observableArray([]);
        self.tagMaxCount = ko.observable(1);
        self.currentPage = ko.observable(1);
        self.totalResults = ko.observable(0);
        self.results = ko.observableArray([]);
        self.searching = ko.observable(false);
        self.resultsPerPage = ko.observable(10);
        self.categories = ko.observableArray([]);
        self.searchStarted = ko.observable(false);
        self.startDate = ko.observable(Date.now());
        self.endDate = ko.observable(Date('1970-01-01'));


        self.totalPages = ko.computed(function() {
            var pageCount = 1;
            var resultsCount = Math.max(self.resultsPerPage(),1); // No Divide by Zero
            pageCount = Math.ceil(self.totalResults() / resultsCount);
            return pageCount;
        });

        self.nextPageExists = ko.computed(function() {
            return ((self.totalPages() > 1) && (self.currentPage() < self.totalPages()));
        });

        self.prevPageExists = ko.computed(function() {
            return self.totalPages() > 1 && self.currentPage() > 1;
        });

        self.currentIndex = ko.computed(function() {
            return Math.max(self.resultsPerPage() * (self.currentPage()-1),0);
        });

        self.navLocation = ko.computed(function() {
            return 'Page ' + self.currentPage() + ' of ' + self.totalPages();
        });

        self.queryObject = ko.computed(function(){
            return {
                'query_string': {
                    'default_field': '_all',
                    'query': self.query() + self.alias(),
                    'analyze_wildcard': true,
                    'lenient': true
                }
            };
        });

        self.dateFilter = ko.computed(function() {
            return {
                'range': {
                    'consumeFinished': {
                        'gte': self.startDate(),
                        'lte': self.endDate()
                    }
                }
            };
        });

        self.fullQuery = ko.computed(function() {
            return {
                'filtered': {
                    'query': self.queryObject()
                }
            };
        });

        self.sortCategories = function(a, b) {
            if(a.name() === 'Total') {
                return -1;
            } else if (b.name() === 'Total') {
                return 1;
            }
            return a.count() >  b.count() ? -1 : 1;
        };

        self.claim = function(mid) {
            claimURL = self.appURL + 'metadata/' + mid + '/promote/';
            $.osf.postJSON(claimURL, {category: 'project'}).success(function(data) {
                window.location = data.url;
            });
        };

        self.help = function() {
            bootbox.dialog({
                title: 'Search help',
                message: '<h4>Queries</h4>'+
                    '<p>Search uses the <a href="http://extensions.xwiki.org/xwiki/bin/view/Extension/Search+Application+Query+Syntax#HAND">Lucene search syntax</a>. ' +
                    'This gives you many options, but can be very simple as well. ' +
                    'Examples of valid searches include:' +
                    '<ul><li><a href="/search/?q=repro*">repro*</a></li>' +
                    '<li><a href="/search/?q=brian+AND+title%3Amany">brian AND title:many</a></li>' +
                    '<li><a href="/search/?q=tags%3A%28psychology%29">tags:(psychology)</a></li></ul>' +
                    '</p>'
            });
        };

        self.filter = function(alias) {
            self.searchStarted(false);
            self.currentPage(1);
            self.category(alias);
            self.alias(alias.getAlias());
            self.search();
        };

        self.addTag = function(name) {
            // To handle passing from template vs. in main html
            var tag = name;

            if(typeof name.name !== 'undefined') {
                tag = name.name();
            }

            self.currentPage(1);
            self.query(self.query() + ' AND tags:("' + tag + '")');
            self.search();
        };

        self.submit = function() {
            self.searchStarted(false);
            self.totalResults(0);
            self.currentPage(1);
            self.search();
        };

        self.search = function(noPush, validate) {
            self.tagMaxCount(1);
            var jsonData = {'query': self.fullQuery(), 'from': self.currentIndex(), 'size': self.resultsPerPage()};
            $.osf.postJSON(self.queryUrl , jsonData).success(function(data) {

                //Clear out our variables
                self.tags([]);
                self.results.removeAll();
                self.categories.removeAll();

                data.results.forEach(function(result){
                    self.results.push(result);
                });

                //Load our categories
                var categories = data.counts;
                $.each(categories, function(key, value){
                    if (value === null) {
                        value = 0;
                    }
                    self.categories.push(new Category(key, value, data.typeAliases[key]));
                });
                self.categories(self.categories().sort(self.sortCategories));

                // If our category is named attempt to load its total else set it to the total total
                if (self.category().name !== undefined) {
                    self.totalResults(data.counts[self.category().rawName()] || 0);
                } else {
                    self.totalResults(self.self.categories()[0].count());
                }

                // Load up our tags
                $.each(data.tags, function(key, value){
                    self.tags.push(new Tag(value));
                    self.tagMaxCount(Math.max(self.tagMaxCount(), value.doc_count));
                });

                self.searchStarted(true);

                if (validate) {
                    self.validateSearch();
                }

                if (!noPush) {
                    self.pushState();
                }

            }).fail(function(){
                console.log('error');
                self.totalResults(0);
                self.currentPage(0);
                self.results.removeAll();
            });

        };

        self.paginate = function(val) {
            window.scrollTo(0, 0);
            self.currentPage(self.currentPage()+val);
            self.search();
        };

        self.pagePrev = self.paginate.bind(self, -1);
        self.pageNext = self.paginate.bind(self, 1);

        //History JS callback
        self.pageChange = function() {
            if (self.stateJustPushed) {
                self.stateJustPushed = false;
                return;
            }

            self.loadState();

            self.search(true);
        };

        //Ensure that the first url displays properly
        self.validateSearch = function() {
            if (self.category().alias !== undefined) {
                possibleCategories = $.map(self.categories().filter(function(category) {
                    return category.count() > 0;
                }), function(category) {
                    return category.alias();
                });

                if (possibleCategories.indexOf(self.category().alias()) === -1) {
                    self.filter(self.categories()[0]);
                    return self.search(true);
                }
            }
            if (self.currentPage() > self.totalPages()) {
                self.currentPage(self.totalPages());
                return self.search(true);
            }
        };

        //Load state from History JS
        self.loadState = function() {
            var state = History.getState().data;
            self.currentPage(state.page || 1);
            self.setCategory(state.filter);
            self.query(state.query || '');
        };

        //Push a new state to History
        self.pushState = function() {
            var state = {
                filter: '',
                query: self.query(),
                page: self.currentPage(),
                scrollTop: $(window).scrollTop(),
            };

            var url = '?q=' + self.query();

            if (self.category().alias !== undefined && self.category().alias() !== undefined) {
                state.filter = self.category().alias();
                url += ('&filter=' + self.category().alias());
            }

            url += ('&page=' + self.currentPage());

            //Indicate that we've just pushed a state so the
            //Call back does not process this push as a state change
            self.stateJustPushed = true;
            History.pushState(state, 'OSF | Search', url);
        };

        self.setCategory = function(cat) {
            if (cat !== undefined && cat !== null && cat !== '') {
                self.category(new Category(cat + 's', cat, cat));
                self.alias(self.category().getAlias());
            } else {
                self.category(new Category('total', 0, 'total'));
                self.alias('');
            }
        };

    };

    function Search(selector, url, appURL) {
        // Initialization code
        var self = this;

        self.viewModel = new ViewModel(url, appURL);
        History.Adapter.bind(window, 'statechange', self.viewModel.pageChange);

        var data = {
            query: qs('q'),
            page: Number(qs('page')),
            scrollTop: 0,
            filter: qs('filter')
        };
        //Ensure our state keeps its URL paramaters
        History.replaceState(data, 'OSF | Search', location.search);
        //Set out observables from the newly replaced state
        self.viewModel.loadState();
        //Preform search from url params
        self.viewModel.search(true, true);

        $.osf.applyBindings(self.viewModel, selector);
    }

    return Search;

}));
